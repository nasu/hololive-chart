/**
 * V ライバー推し探しチャート（ホロライブ / にじさんじ）
 *
 * データ層は data/<brand>/*.json に分離。将来サーバー管理に移行する場合は
 * DataSource の fetch 先を API エンドポイントに差し替えるだけでよい。
 * 文言・ブランチ構成・性別フィルタの有無はすべてデータ駆動。
 */

// ---------- データ層 ----------

// デプロイ毎にバージョンを上げてキャッシュの不整合を防ぐ
// (index.html の ?v= と合わせること)
const APP_VERSION = "11";

const DataSource = {
  async loadBrands() {
    const res = await fetch(`data/brands.json?v=${APP_VERSION}`);
    if (!res.ok) throw new Error("ブランド一覧の読み込みに失敗しました");
    return (await res.json()).brands;
  },

  async load(brandId) {
    const [membersRes, questionsRes] = await Promise.all([
      fetch(`data/${brandId}/members.json?v=${APP_VERSION}`),
      fetch(`data/${brandId}/questions.json?v=${APP_VERSION}`),
    ]);
    if (!membersRes.ok || !questionsRes.ok) {
      throw new Error("データの読み込みに失敗しました");
    }
    const membersData = await membersRes.json();
    const questionsData = await questionsRes.json();
    return {
      brand: membersData.brand,
      paramLabels: membersData.paramLabels,
      paramScale: membersData.paramScale || 10,
      members: membersData.members,
      questions: questionsData.questions,
      modes: questionsData.modes,
    };
  },
};

// ---------- スコア計算 ----------

const Matcher = {
  /**
   * answers: 選択された option オブジェクトの配列
   * 返り値: { paramWeights, tagCounts }
   */
  buildProfile(answers) {
    const paramWeights = {};
    const tagCounts = {};
    for (const opt of answers) {
      for (const [p, w] of Object.entries(opt.params || {})) {
        paramWeights[p] = (paramWeights[p] || 0) + w;
      }
      for (const t of opt.tags || []) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }
    return { paramWeights, tagCounts };
  },

  /**
   * ユーザー嗜好をレーダーチャートと同じ 0〜scale のベクトルに正規化。
   * マッチ度はこのベクトルとメンバーパラメータの「形の近さ」に基づくため、
   * チャートの重なり具合とマッチ度%が連動する。
   */
  userVector(profile, keys, scale) {
    const maxW = Math.max(1, ...keys.map((k) => profile.paramWeights[k] || 0));
    const u = {};
    for (const k of keys) {
      u[k] = ((profile.paramWeights[k] || 0) / maxW) * scale;
    }
    return u;
  },

  /**
   * マッチ度（絶対値、0〜100）:
   * - パラメータ一致: 9軸の平均差が小さいほど高い（最大90点）
   * - タグ一致: 選んだ回答のタグとメンバータグの一致で加点（最大10点）
   */
  score(member, profile, userVals, scale) {
    const keys = Object.keys(member.params);
    let diffSum = 0;
    for (const k of keys) {
      diffSum += Math.abs(userVals[k] - (member.params[k] || 0));
    }
    const shape = 1 - diffSum / keys.length / scale;

    let tagPoints = 0;
    const hitTags = [];
    for (const t of member.tags) {
      if (profile.tagCounts[t]) {
        tagPoints += 2.5 * profile.tagCounts[t];
        hitTags.push(t);
      }
    }
    tagPoints = Math.min(10, tagPoints);

    return { percent: Math.round(shape * 90 + tagPoints), hitTags };
  },

  rank(members, answers, { branches, includeGraduated, gender = "all", scale = 10 }) {
    const profile = this.buildProfile(answers);
    const pool = members.filter(
      (m) =>
        branches.includes(m.branch) &&
        (includeGraduated || m.status === "active") &&
        (gender === "all" || !m.gender || m.gender === "u" || m.gender === gender)
    );
    const keys = pool.length > 0 ? Object.keys(pool[0].params) : [];
    const userVals = this.userVector(profile, keys, scale);
    const scored = pool.map((m) => {
      const { percent, hitTags } = this.score(m, profile, userVals, scale);
      return { member: m, percent, hitTags };
    });
    scored.sort((a, b) => b.percent - a.percent);
    return scored;
  },
};

// ---------- UI ----------

const App = {
  brands: null,
  data: null,
  state: {
    view: "landing", // landing | home | quiz | result | members
    brand: null,
    branches: [],
    gender: "all", // all | f | m
    includeGraduated: false,
    mode: "quick", // quick | deep
    currentQuestion: 0,
    answers: [], // 選択した option
    memberFilter: "ALL",
  },

  /** 性別データを持つブランドかどうか（性別フィルタの表示判定） */
  hasGenderFilter() {
    const genders = new Set(
      this.data.members.map((m) => m.gender).filter((g) => g && g !== "u")
    );
    return genders.size > 1;
  },

  matchesGender(m) {
    const g = this.state.gender;
    return g === "all" || !m.gender || m.gender === "u" || m.gender === g;
  },

  async selectBrand(brandId) {
    this.root.innerHTML = '<div class="loading">読み込み中…</div>';
    try {
      this.data = await DataSource.load(brandId);
    } catch (e) {
      this.root.innerHTML = `<div class="loading">読み込みエラー: ${e.message}</div>`;
      return;
    }
    const s = this.state;
    s.brand = brandId;
    s.branches = this.data.brand.branches.map((b) => b.key);
    s.gender = "all";
    s.includeGraduated = false;
    s.mode = "quick";
    s.currentQuestion = 0;
    s.answers = [];
    s.memberFilter = "ALL";
    s.view = "home";
    this.render();
  },

  /** 選択中モードの質問リスト */
  activeQuestions() {
    const mode = this.data.modes.find((m) => m.id === this.state.mode);
    const byId = new Map(this.data.questions.map((q) => [q.id, q]));
    return mode.questionIds.map((id) => byId.get(id));
  },

  async init() {
    this.root = document.getElementById("app");
    document.getElementById("brandBtn").addEventListener("click", () => {
      this.state.view = "landing";
      this.render();
    });
    document.getElementById("navMembersBtn").addEventListener("click", () => {
      this.state.view = this.data ? "members" : "landing";
      this.render();
    });
    try {
      this.brands = await DataSource.loadBrands();
    } catch (e) {
      this.root.innerHTML = `<div class="loading">読み込みエラー: ${e.message}<br>ローカルで開く場合は簡易サーバー（例: npx serve）経由でアクセスしてください。</div>`;
      return;
    }
    this.render();
  },

  render() {
    const views = {
      landing: () => this.renderLanding(),
      home: () => this.renderHome(),
      quiz: () => this.renderQuiz(),
      result: () => this.renderResult(),
      members: () => this.renderMembers(),
    };
    // メンバー一覧はブランド選択後のみ意味を持つ
    const navBtn = document.getElementById("navMembersBtn");
    navBtn.hidden = !this.data;
    if (this.data) {
      navBtn.textContent = this.data.brand.membersLabel || "メンバー一覧";
    }
    this.root.innerHTML = "";
    this.root.appendChild(views[this.state.view]());
    window.scrollTo(0, 0);
  },

  // ---- ブランド選択 ----
  renderLanding() {
    const wrap = this.el("div");
    wrap.appendChild(
      this.el("div", { class: "hero" }, [
        this.el("h1", { text: "推しあわせ" }),
        this.el("p", {
          text: "質問に答えて、あなたにぴったりのVライバー（推し）と出会う診断チャート。まずは箱を選んでね。",
        }),
      ])
    );
    const row = this.el("div", { class: "brand-row" });
    for (const b of this.brands) {
      const btn = this.el("button", {
        type: "button",
        class: "brand-card",
        style: `border-color: ${b.color}`,
        onclick: () => this.selectBrand(b.id),
      });
      btn.appendChild(this.el("span", { class: "brand-emoji", text: b.emoji }));
      const nameEl = this.el("span", { class: "brand-name", text: b.name });
      if (b.badge) {
        nameEl.appendChild(this.el("span", { class: "alpha-badge", text: b.badge }));
      }
      btn.appendChild(nameEl);
      btn.appendChild(
        this.el("small", { text: `${b.tagline} / ${b.countLabel}` })
      );
      row.appendChild(btn);
    }
    wrap.appendChild(row);
    return wrap;
  },

  el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c) node.appendChild(c);
    }
    return node;
  },

  /** 推し色つき絵文字アバター */
  avatar(member, size = "") {
    return this.el("span", {
      class: "avatar" + (size ? ` avatar-${size}` : ""),
      style: `background: ${member.color}22; border-color: ${member.color}`,
      text: member.emoji,
      "aria-hidden": "true",
    });
  },

  /** チャンネルの最新動画プレイリスト埋め込み（UC → UU がアップロード一覧） */
  embedToggle(member) {
    if (!member.youtube || !member.youtube.channelId) return null;
    const listId = "UU" + member.youtube.channelId.slice(2);
    const wrap = this.el("div", { class: "embed-wrap" });
    const btn = this.el("button", {
      type: "button",
      class: "embed-btn",
      style: `border-color: ${member.color}; color: ${member.color}`,
      text: "▶ 最新の配信・動画を見る",
      onclick: () => {
        btn.remove();
        wrap.appendChild(
          this.el("div", { class: "embed-frame" }, [
            this.el("iframe", {
              src: `https://www.youtube.com/embed/videoseries?list=${listId}`,
              title: `${member.name} のチャンネル`,
              allow:
                "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
              allowfullscreen: "",
              loading: "lazy",
            }),
          ])
        );
      },
    });
    wrap.appendChild(btn);
    return wrap;
  },

  /**
   * ライバーのパラメータとユーザー嗜好を重ねたレーダーチャート（SVG）。
   * ユーザー嗜好は回答の重み合計を最大値=10 に正規化して比較する。
   */
  radarChart(member, profile) {
    const keys = Object.keys(this.data.paramLabels);
    const SHORT = {
      energy: "元気",
      healing: "癒し",
      talk: "トーク",
      game: "ゲーム",
      music: "歌",
      comedy: "笑い",
      chaos: "カオス",
      cute: "かわいい",
      cool: "クール",
    };
    const scale = this.data.paramScale;
    const cx = 160,
      cy = 145,
      R = 95;
    const angle = (i) => (Math.PI * 2 * i) / keys.length - Math.PI / 2;
    const pt = (i, v) => {
      const r = (R * v) / scale;
      return [
        +(cx + Math.cos(angle(i)) * r).toFixed(1),
        +(cy + Math.sin(angle(i)) * r).toFixed(1),
      ];
    };
    const poly = (vals) =>
      keys.map((k, i) => pt(i, vals[k] || 0).join(",")).join(" ");

    const userVals = Matcher.userVector(profile, keys, scale);

    let grid = "";
    for (const lv of [0.25, 0.5, 0.75, 1]) {
      const ring = keys
        .map((k, i) => pt(i, scale * lv).join(","))
        .join(" ");
      grid += `<polygon points="${ring}" fill="none" stroke="#dde5ef" stroke-width="1"/>`;
    }
    let axes = "";
    let labels = "";
    keys.forEach((k, i) => {
      const [x, y] = pt(i, scale);
      axes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#dde5ef" stroke-width="1"/>`;
      const [lx, ly] = pt(i, scale * 1.22);
      labels += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="#6b7a90">${SHORT[k]}</text>`;
    });

    const div = this.el("div", { class: "radar-wrap" });
    div.innerHTML = `
      <svg viewBox="0 0 320 300" role="img" aria-label="${member.name}とあなたの嗜好の比較チャート">
        ${grid}${axes}
        <polygon points="${poly(member.params)}" fill="${member.color}44" stroke="${member.color}" stroke-width="2"/>
        <polygon points="${poly(userVals)}" fill="none" stroke="#1f2a3d" stroke-width="2" stroke-dasharray="5 4"/>
        ${labels}
      </svg>
      <div class="radar-legend">
        <span><i style="background:${member.color}44; border: 2px solid ${member.color}"></i>${member.name}</span>
        <span><i style="border: 2px dashed #1f2a3d"></i>あなたの好み</span>
      </div>`;
    return div;
  },

  channelUrl(member) {
    if (member.youtube && member.youtube.channelId) {
      return `https://www.youtube.com/channel/${member.youtube.channelId}`;
    }
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(
      member.name + " " + this.data.brand.label
    )}`;
  },

  /** YouTube / X の外部リンク行 */
  linkRow(member) {
    const row = this.el("div", { class: "link-row" });
    if (member.youtube || this.data.brand.youtubeFallback) {
      row.appendChild(
        this.el("a", {
          class: "yt-link",
          href: this.channelUrl(member),
          target: "_blank",
          rel: "noopener",
          text: "▶ YouTube",
        })
      );
    }
    if (member.twitter) {
      row.appendChild(
        this.el("a", {
          class: "yt-link x-link",
          href: `https://x.com/${member.twitter}`,
          target: "_blank",
          rel: "noopener",
          text: `𝕏 @${member.twitter}`,
        })
      );
    }
    return row.children.length > 0 ? row : null;
  },

  /** メンバー詳細モーダル */
  showMemberModal(member) {
    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);

    const overlay = this.el("div", {
      class: "modal-overlay",
      onclick: (e) => {
        if (e.target === overlay) close();
      },
    });
    const panel = this.el("div", {
      class: "modal-panel",
      style: `border-top: 6px solid ${member.color}`,
      role: "dialog",
      "aria-label": member.name,
    });
    panel.appendChild(
      this.el("button", {
        type: "button",
        class: "modal-close",
        text: "×",
        "aria-label": "閉じる",
        onclick: close,
      })
    );
    const head = this.el("div", { class: "modal-head" }, [
      this.avatar(member, "lg"),
    ]);
    const nameBox = this.el("div", {});
    const h = this.el("h2", { text: member.name });
    if (member.status === "graduated") {
      h.appendChild(this.el("span", { class: "badge-grad", text: "卒業生" }));
    }
    nameBox.appendChild(h);
    nameBox.appendChild(
      this.el("p", {
        class: "result-meta",
        text:
          this.data.brand.branches.length > 1
            ? `${member.nameEn} / ${this.data.brand.label} ${member.branch} ${member.group}`
            : `${member.nameEn} / ${this.data.brand.label} ${member.group}`,
      })
    );
    head.appendChild(nameBox);
    panel.appendChild(head);

    if (member.description) {
      panel.appendChild(
        this.el("p", { class: "member-desc", text: member.description })
      );
    }
    const tags = this.el("div", { class: "tag-list" });
    for (const t of member.tags) {
      tags.appendChild(this.el("span", { class: "tag", text: "#" + t }));
    }
    panel.appendChild(tags);
    const stBlock = this.searchTagsBlock(member);
    if (stBlock) panel.appendChild(stBlock);
    const links = this.linkRow(member);
    if (links) panel.appendChild(links);
    const embed = this.embedToggle(member);
    if (embed) panel.appendChild(embed);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  },

  // ---- トップページ ----
  renderHome() {
    const s = this.state;
    const wrap = this.el("div");

    const heroTitle = this.el("h1", {
      text: `${this.data.brand.name}推し探しチャート`,
    });
    if (this.data.brand.badge) {
      heroTitle.appendChild(
        this.el("span", { class: "alpha-badge", text: this.data.brand.badge })
      );
    }
    wrap.appendChild(
      this.el("div", { class: "hero" }, [
        heroTitle,
        this.el("p", {
          text: "質問に答えて、あなたにぴったりの推しを見つけよう！",
        }),
      ])
    );

    const card = this.el("div", { class: "setup-card" });

    // ブランチ選択（複数ブランチのあるブランドのみ）
    const branchDefs = this.data.brand.branches;
    if (branchDefs.length > 1) {
      const branchSection = this.el("section", {}, [
        this.el("h2", { text: "どのブランチから探す？（複数選択OK）" }),
      ]);
      const branchRow = this.el("div", { class: "choice-row" });
      for (const b of branchDefs) {
        const btn = this.el("button", {
          type: "button",
          class: "choice" + (s.branches.includes(b.key) ? " selected" : ""),
          onclick: () => {
            if (s.branches.includes(b.key)) {
              s.branches = s.branches.filter((x) => x !== b.key);
            } else {
              s.branches.push(b.key);
            }
            this.render();
          },
        });
        btn.appendChild(document.createTextNode(b.label));
        btn.appendChild(this.el("small", { text: b.desc }));
        branchRow.appendChild(btn);
      }
      branchSection.appendChild(branchRow);
      card.appendChild(branchSection);
    }

    // 卒業生（卒業生データのあるブランドのみ）
    if (this.data.members.some((m) => m.status === "graduated")) {
      const gradSection = this.el("section", {}, [
        this.el("h2", { text: "卒業生も含める？" }),
      ]);
      const gradRow = this.el("div", { class: "choice-row" });
      for (const [val, label, desc] of [
        [false, "現役のみ", "いま活動中のメンバー"],
        [true, "卒業生も含める", "伝説にも会いたい"],
      ]) {
        const btn = this.el("button", {
          type: "button",
          class: "choice" + (s.includeGraduated === val ? " selected" : ""),
          onclick: () => {
            s.includeGraduated = val;
            this.render();
          },
        });
        btn.appendChild(document.createTextNode(label));
        btn.appendChild(this.el("small", { text: desc }));
        gradRow.appendChild(btn);
      }
      gradSection.appendChild(gradRow);
      card.appendChild(gradSection);
    }

    // 性別フィルタ（男女両方いるブランドのみ表示）
    if (this.hasGenderFilter()) {
      const genderSection = this.el("section", {}, [
        this.el("h2", { text: "推したいライバーは？" }),
      ]);
      const genderRow = this.el("div", { class: "choice-row" });
      for (const [val, label, desc] of [
        ["all", "どちらも", "全ライバー対象"],
        ["f", "女性ライバー", ""],
        ["m", "男性ライバー", ""],
      ]) {
        const btn = this.el("button", {
          type: "button",
          class: "choice" + (s.gender === val ? " selected" : ""),
          onclick: () => {
            s.gender = val;
            this.render();
          },
        });
        btn.appendChild(document.createTextNode(label));
        if (desc) btn.appendChild(this.el("small", { text: desc }));
        genderRow.appendChild(btn);
      }
      genderSection.appendChild(genderRow);
      card.appendChild(genderSection);
    }

    // 診断モード（複数モードのあるブランドのみ）
    if (this.data.modes.length > 1) {
      const modeSection = this.el("section", {}, [
        this.el("h2", { text: "診断モード" }),
      ]);
      const modeRow = this.el("div", { class: "choice-row" });
      for (const mode of this.data.modes) {
        const btn = this.el("button", {
          type: "button",
          class: "choice" + (s.mode === mode.id ? " selected" : ""),
          onclick: () => {
            s.mode = mode.id;
            this.render();
          },
        });
        btn.appendChild(document.createTextNode(mode.label));
        btn.appendChild(this.el("small", { text: mode.desc }));
        modeRow.appendChild(btn);
      }
      modeSection.appendChild(modeRow);
      card.appendChild(modeSection);
    }

    if (this.data.brand.resultNote) {
      wrap.appendChild(
        this.el("p", { class: "brand-note", text: this.data.brand.resultNote })
      );
    }
    if (card.children.length > 0) wrap.appendChild(card);

    const startBtn = this.el("button", {
      type: "button",
      class: "start-btn",
      text: "診断をはじめる",
      onclick: () => {
        s.currentQuestion = 0;
        s.answers = [];
        s.view = "quiz";
        this.render();
      },
    });
    if (s.branches.length === 0) startBtn.disabled = true;
    wrap.appendChild(startBtn);

    const count = this.data.members.filter(
      (m) =>
        s.branches.includes(m.branch) &&
        (s.includeGraduated || m.status === "active") &&
        this.matchesGender(m)
    ).length;
    const unit = this.data.brand.unit || "人";
    wrap.appendChild(
      this.el("p", {
        class: "hint",
        text:
          s.branches.length === 0
            ? "ブランチを1つ以上選んでね"
            : `対象${unit === "人" ? "メンバー" : unit}: ${count}${unit}`,
      })
    );

    return wrap;
  },

  // ---- 質問 ----
  renderQuiz() {
    const s = this.state;
    const questions = this.activeQuestions();
    const q = questions[s.currentQuestion];
    const total = questions.length;
    const wrap = this.el("div");

    wrap.appendChild(
      this.el("div", { class: "progress-wrap" }, [
        this.el("div", {
          class: "progress-label",
          text: `質問 ${s.currentQuestion + 1} / ${total}`,
        }),
        this.el("div", { class: "progress-bar" }, [
          this.el("div", {
            class: "progress-fill",
            style: `width: ${(s.currentQuestion / total) * 100}%`,
          }),
        ]),
      ])
    );

    const card = this.el("div", { class: "question-card" }, [
      this.el("h2", { text: q.text }),
    ]);
    const list = this.el("div", { class: "option-list" });
    for (const opt of q.options) {
      list.appendChild(
        this.el("button", {
          type: "button",
          class: "option-btn",
          text: opt.label,
          onclick: () => {
            s.answers[s.currentQuestion] = opt;
            if (s.currentQuestion + 1 >= total) {
              s.view = "result";
            } else {
              s.currentQuestion += 1;
            }
            this.render();
          },
        })
      );
    }
    card.appendChild(list);
    wrap.appendChild(card);

    const nav = this.el("div", { class: "quiz-nav" });
    nav.appendChild(
      this.el("button", {
        type: "button",
        class: "back-btn",
        text: s.currentQuestion === 0 ? "← トップに戻る" : "← 前の質問へ",
        onclick: () => {
          if (s.currentQuestion === 0) {
            s.view = "home";
          } else {
            s.currentQuestion -= 1;
            s.answers.length = s.currentQuestion;
          }
          this.render();
        },
      })
    );
    wrap.appendChild(nav);

    return wrap;
  },

  /** アプリ内検索タグの案内ブロック（searchTags を持つメンバー=タイプのみ） */
  searchTagsBlock(m) {
    if (!m.searchTags || m.searchTags.length === 0) return null;
    const st = this.el("div", { class: "search-tags" }, [
      this.el("h3", { text: `🔎 ${this.data.brand.label}アプリでの探し方` }),
    ]);
    const chips = this.el("div", { class: "tag-list" });
    for (const t of m.searchTags) {
      chips.appendChild(this.el("span", { class: "tag hit", text: t }));
    }
    st.appendChild(chips);
    st.appendChild(
      this.el("p", {
        class: "hint-small",
        text: "アプリの検索やタグでこのキーワードを探すと、このタイプのライバーに出会いやすいよ。",
      })
    );
    if (this.data.brand.appUrl) {
      st.appendChild(
        this.el("a", {
          class: "yt-link",
          href: this.data.brand.appUrl,
          target: "_blank",
          rel: "noopener",
          text: `▶ ${this.data.brand.label}を開く`,
        })
      );
    }
    return st;
  },

  /** 結果カード（トップ3・4位以下の展開詳細で共用） */
  buildResultCard(r, rank, profile, isFirst) {
    const m = r.member;
    const card = this.el("div", {
      class: "result-card" + (isFirst ? " first" : ""),
      style: `border-left: 6px solid ${m.color}`,
    });
    card.appendChild(this.el("span", { class: "rank-badge", text: `${rank}位` }));
    const head = this.el("div", { class: "result-head" });
    const name = this.el("h2", { class: "result-name" }, [
      this.avatar(m, isFirst ? "lg" : ""),
    ]);
    name.appendChild(document.createTextNode(m.name));
    name.appendChild(this.el("small", { text: m.nameEn }));
    head.appendChild(name);
    head.appendChild(
      this.el("span", { class: "match-pct", text: `マッチ度 ${r.percent}%` })
    );
    card.appendChild(head);
    card.appendChild(
      this.el("p", {
        class: "result-meta",
        text:
          (this.data.brand.branches.length > 1
            ? `${this.data.brand.label} ${m.branch} / ${m.group}`
            : `${this.data.brand.label} / ${m.group}`) +
          (m.status === "graduated" ? "（卒業生）" : ""),
      })
    );
    const tags = this.el("div", { class: "tag-list" });
    for (const t of m.tags) {
      tags.appendChild(
        this.el("span", {
          class: "tag" + (r.hitTags.includes(t) ? " hit" : ""),
          text: "#" + t,
        })
      );
    }
    if (m.description) {
      card.appendChild(
        this.el("p", { class: "member-desc", text: m.description })
      );
    }
    card.appendChild(tags);
    card.appendChild(this.radarChart(m, profile));
    const st = this.searchTagsBlock(m);
    if (st) card.appendChild(st);
    const links = this.linkRow(m);
    if (links) card.appendChild(links);
    const embed = this.embedToggle(m);
    if (embed) card.appendChild(embed);
    return card;
  },

  // ---- 結果 ----
  renderResult() {
    const s = this.state;
    const ranked = Matcher.rank(this.data.members, s.answers, {
      branches: s.branches,
      includeGraduated: s.includeGraduated,
      gender: s.gender,
    });
    const profile = Matcher.buildProfile(s.answers);
    const wrap = this.el("div");
    wrap.appendChild(
      this.el("h1", {
        class: "result-title",
        text: this.data.brand.resultTitle || "あなたの推し候補はこちら！",
      })
    );

    const top3 = ranked.slice(0, 3);
    top3.forEach((r, i) => {
      wrap.appendChild(this.buildResultCard(r, i + 1, profile, i === 0));
    });

    // 4位以下: トグルで詳細（レーダー含む）を開ける
    const rest = ranked.slice(3, 10);
    if (rest.length > 0) {
      const list = this.el("div", { class: "runner-list" }, [
        this.el("h3", { text: "こちらも気になるかも" }),
      ]);
      rest.forEach((r, i) => {
        const rank = i + 4;
        const label = this.el("span", {}, [this.avatar(r.member)]);
        label.appendChild(
          document.createTextNode(
            `${rank}位  ${r.member.name}（${r.member.group}${
              r.member.status === "graduated" ? "・卒業生" : ""
            }）`
          )
        );
        const right = this.el("span", { class: "runner-right" }, [
          this.el("span", { class: "pct", text: `${r.percent}%` }),
          this.el("span", { class: "chevron", text: "▾" }),
        ]);
        const item = this.el("div", { class: "runner" });
        let detail = null;
        const btn = this.el("button", {
          type: "button",
          class: "runner-item",
          onclick: () => {
            if (!detail) {
              detail = this.buildResultCard(r, rank, profile, false);
              detail.classList.add("runner-detail");
              item.appendChild(detail);
            } else {
              detail.hidden = !detail.hidden;
            }
            item.classList.toggle("open", !detail.hidden);
          },
        });
        btn.appendChild(label);
        btn.appendChild(right);
        item.appendChild(btn);
        list.appendChild(item);
      });
      wrap.appendChild(list);
    }

    // 事務所紹介（brand.agencies があるブランドのみ・毎回ランダムに4社）
    if (this.data.brand.agencies && this.data.brand.agencies.length > 0) {
      const ag = this.el("div", { class: "agency-card" }, [
        this.el("h3", { text: "🏢 事務所から探すのもおすすめ" }),
        this.el("p", {
          class: "hint-small",
          text: "IRIAMには100社以上のライバー事務所があり、事務所の所属一覧から探すのも近道。実在確認済みの事務所から毎回ランダムに4社紹介するよ（タイプ別の得意分野までは紐付けていないので、あくまで入口として）。",
        }),
      ]);
      const picked = [...this.data.brand.agencies]
        .sort(() => Math.random() - 0.5)
        .slice(0, 4);
      for (const a of picked) {
        const row = this.el("div", { class: "agency-row" });
        row.appendChild(
          this.el("a", {
            class: "yt-link",
            href: a.url,
            target: "_blank",
            rel: "noopener",
            text: a.name,
          })
        );
        row.appendChild(this.el("span", { class: "agency-note", text: a.note }));
        ag.appendChild(row);
      }
      wrap.appendChild(ag);
    }

    const actions = this.el("div", { class: "result-actions" });
    actions.appendChild(
      this.el("button", {
        type: "button",
        class: "secondary-btn",
        text: "もう一度診断する",
        onclick: () => {
          s.view = "home";
          this.render();
        },
      })
    );
    actions.appendChild(
      this.el("button", {
        type: "button",
        class: "secondary-btn",
        text: "メンバー一覧を見る",
        onclick: () => {
          s.view = "members";
          this.render();
        },
      })
    );
    wrap.appendChild(actions);

    return wrap;
  },

  // ---- メンバー一覧 ----
  renderMembers() {
    const s = this.state;
    const wrap = this.el("div");

    const header = this.el("div", { class: "members-header" }, [
      this.el("h1", { text: this.data.brand.membersLabel || "メンバー一覧" }),
    ]);
    const filterKeys = ["ALL"];
    if (this.data.brand.branches.length > 1) {
      filterKeys.push(...this.data.brand.branches.map((b) => b.key));
    }
    if (this.data.members.some((m) => m.status === "graduated")) {
      filterKeys.push("卒業生");
    }
    if (filterKeys.length > 1) {
      const filters = this.el("div", { class: "filter-row" });
      for (const f of filterKeys) {
        filters.appendChild(
          this.el("button", {
            type: "button",
            class: "filter-btn" + (s.memberFilter === f ? " active" : ""),
            text: f === "ALL" ? "すべて" : f,
            onclick: () => {
              s.memberFilter = f;
              this.render();
            },
          })
        );
      }
      header.appendChild(filters);
    }
    wrap.appendChild(header);

    let members = this.data.members;
    if (s.memberFilter === "卒業生") {
      members = members.filter((m) => m.status === "graduated");
    } else if (s.memberFilter !== "ALL") {
      members = members.filter((m) => m.branch === s.memberFilter);
    }

    // グループ単位で表示（データの登場順を維持）
    const multiBranch = this.data.brand.branches.length > 1;
    const groups = [];
    const groupMap = new Map();
    for (const m of members) {
      const key = multiBranch ? `${m.branch} ${m.group}` : m.group;
      if (!groupMap.has(key)) {
        groupMap.set(key, []);
        groups.push(key);
      }
      groupMap.get(key).push(m);
    }

    for (const g of groups) {
      wrap.appendChild(this.el("h2", { class: "group-heading", text: g }));
      const grid = this.el("div", { class: "member-grid" });
      for (const m of groupMap.get(g)) {
        const card = this.el("button", {
          type: "button",
          class: "member-card",
          style: `border-top: 4px solid ${m.color}`,
          onclick: () => this.showMemberModal(m),
        });
        const h = this.el("h3", {}, [this.avatar(m)]);
        h.appendChild(document.createTextNode(m.name));
        h.appendChild(this.el("small", { text: m.nameEn }));
        if (m.status === "graduated") {
          h.appendChild(this.el("span", { class: "badge-grad", text: "卒業生" }));
        }
        card.appendChild(h);
        card.appendChild(
          this.el("div", {
            class: "meta",
            text: multiBranch
              ? `${this.data.brand.label} ${m.branch}`
              : this.data.brand.label,
          })
        );
        const tags = this.el("div", { class: "tag-list" });
        for (const t of m.tags) {
          tags.appendChild(this.el("span", { class: "tag", text: "#" + t }));
        }
        card.appendChild(tags);
        card.appendChild(
          this.el("span", { class: "detail-hint", text: "タップで詳細 ▸" })
        );
        grid.appendChild(card);
      }
      wrap.appendChild(grid);
    }

    return wrap;
  },
};

App.init();

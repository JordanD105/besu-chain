const view = document.querySelector("#view");
const nav = document.querySelector("#nav");
const tableStates = new Map();
function isoDay(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

let pageTab = "";
let chartStart = isoDay(new Date());
let chartEnd = chartStart;
let chartWheel = 0;
let chartWheelTimer = 0;
let chartAnimate = false;
let txTab = "function";
let enodeOpen = false;
let showToken = 0;
let showRefresh = false;
let shownHash = null;
let viewReady = false;
let rendering = false;
let viewDirty = false;
let statusSig = "";
let lastViewRefresh = Date.now();

const themeButton = document.querySelector("#theme");
const themeIcons = {
    light: "<svg viewBox='0 0 24 24' aria-hidden='true'><circle cx='12' cy='12' r='4' fill='currentColor'/><g fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round'><path d='M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.1 5.1l1.6 1.6M17.3 17.3l1.6 1.6M18.9 5.1l-1.6 1.6M6.7 17.3l-1.6 1.6'/></g></svg>",
    dark: "<svg viewBox='0 0 24 24' aria-hidden='true'><path fill='currentColor' d='M15.2 2.4a8.8 8.8 0 1 0 6.4 14.8A9.2 9.2 0 0 1 15.2 2.4z'/></svg>"
};

function applyTheme(light) {
    document.body.classList.toggle("light", light);
    themeButton.innerHTML = themeIcons[light ? "dark" : "light"];
    themeButton.setAttribute("aria-label", t(light ? "theme.dark" : "theme.light"));
    localStorage.setItem("chainlens.theme", light ? "light" : "dark");
}

applyTheme(localStorage.getItem("chainlens.theme") === "light");
themeButton.addEventListener("click", () => {
    applyTheme(!document.body.classList.contains("light"));
});

document.querySelector("#chain-toggle").addEventListener("click", () => {
    document.querySelector("#chain-links").hidden = !document.querySelector("#chain-links").hidden;
});

document.querySelector("#search").addEventListener("submit", async (event) => {
    event.preventDefault();
    const q = document.querySelector("#search-input").value.trim();

    if (!q) {
        return;
    }

    const body = await api("/api/search?q=" + encodeURIComponent(q));

    if (body.results && body.results[0]) {
        location.hash = body.results[0].href;
    } else {
        view.replaceChildren(el("div", { class: "card" }, t("search.none")));
    }
});

function el(tag, attrs, children) {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs || {})) {
        if (key === "class") {
            node.className = value;
        } else if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
            node.setAttribute(key, value);
        }
    }

    for (const child of [].concat(children || [])) {
        if (child == null || child === false) {
            continue;
        }

        node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }

    return node;
}

function short(value) {
    if (!value) {
        return "";
    }

    if (value.length < 14) {
        return value;
    }

    return value.slice(0, 6) + "…" + value.slice(-4);
}

function stamp(ts) {
    const date = new Date(Number(ts) * 1000);

    if (!ts || Number.isNaN(date.getTime())) {
        return "—";
    }

    const pad = (value) => String(value).padStart(2, "0");
    return date.getFullYear() + "." + pad(date.getMonth() + 1) + "." + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

function ago(ts) {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000 - ts));

    if (seconds < 60) {
        return t("time.ltMinute");
    }

    if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        return t(minutes === 1 ? "time.minute" : "time.minutes", { n: minutes });
    }

    if (seconds < 86400) {
        const hours = Math.floor(seconds / 3600);
        return t(hours === 1 ? "time.hour" : "time.hours", { n: hours });
    }

    const days = Math.floor(seconds / 86400);
    return t(days === 1 ? "time.day" : "time.days", { n: days });
}

function copyText(value) {
    const fallback = () => new Promise((resolve, reject) => {
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.append(area);
        area.select();

        try {
            if (!document.execCommand("copy")) {
                reject(new Error("copy failed"));
                return;
            }

            resolve();
        } catch (error) {
            reject(error);
        } finally {
            area.remove();
        }
    });

    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(value).catch(() => fallback());
    }

    return fallback();
}

function svgIcon(path) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("fill", "currentColor");
    shape.setAttribute("d", path);
    svg.append(shape);
    return svg;
}

function copyButton(value) {
    const copyPath = "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z";
    const donePath = "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z";
    const glyph = svgIcon(copyPath);
    const button = el("button", { type: "button", class: "copy", "aria-label": t("copy.action") }, glyph);
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        copyText(value).then(() => {
            glyph.querySelector("path").setAttribute("d", donePath);
            button.setAttribute("aria-label", t("copy.done"));
            setTimeout(() => {
                glyph.querySelector("path").setAttribute("d", copyPath);
                button.setAttribute("aria-label", t("copy.action"));
            }, 1200);
        }).catch(() => {});
    });
    return button;
}

function placeTip(pop, trigger) {
    const rect = trigger.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    let left = rect.left;
    let top = rect.bottom + 4;

    if (left + width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - width - 8);
    }

    if (top + height > window.innerHeight - 8) {
        top = Math.max(8, rect.top - height - 4);
    }

    pop.style.left = left + "px";
    pop.style.top = top + "px";
}

function addressTip(trigger, rows) {
    if (trigger.tagName !== "A" && trigger.tagName !== "BUTTON" && !trigger.hasAttribute("tabindex")) {
        trigger.tabIndex = 0;
    }

    const pop = el("span", { class: "tip-pop", role: "tooltip", hidden: "" });

    for (const row of rows) {
        const line = el("span", { class: "tip-row" }, [
            row.label ? el("span", { class: "tip-label" }, row.label) : null,
            el("span", { class: "tip-value" }, row.value),
            row.copy === false ? null : copyButton(row.value)
        ]);
        pop.append(line);
    }

    const wrap = el("span", { class: "tip" }, [trigger, pop]);
    let timer = 0;
    const open = () => {
        clearTimeout(timer);
        pop.hidden = false;
        placeTip(pop, trigger);
    };
    const close = () => {
        timer = setTimeout(() => {
            pop.hidden = true;
        }, 200);
    };

    wrap.addEventListener("mouseenter", open);
    wrap.addEventListener("mouseleave", close);
    pop.addEventListener("mouseenter", open);
    pop.addEventListener("mouseleave", close);
    trigger.addEventListener("focus", open);
    wrap.addEventListener("focusin", open);
    wrap.addEventListener("focusout", (event) => {
        if (!wrap.contains(event.relatedTarget)) {
            close();
        }
    });
    return wrap;
}

function ident(value, href) {
    const text = short(value);
    const trigger = href ? el("a", { class: "addr", href }, text) : el("span", { class: "addr" }, text);
    return addressTip(trigger, [{ value }]);
}

function addr(address, href) {
    return ident(address, href || ("#/accounts/" + address));
}

function contractLink(label, address, href) {
    const link = el("a", { href }, label || short(address));
    const rows = [{ label: t("tip.contract"), value: address }];

    if (label && label !== address) {
        rows.push({ label: t("tip.nft"), value: label, copy: false });
    }

    return addressTip(link, rows);
}

function copyValue(value) {
    return addressTip(el("span", { class: "copy-value" }, value), [{ value }]);
}

function badge(type) {
    const key = type === "call" ? "tx.call" : (type === "create" ? "tx.create" : "tx.transfer");
    return el("span", { class: "badge " + (type || "transfer") }, t(key));
}

function fnLabel(name) {
    if (name === "send") {
        return t("fn.send");
    }

    if (name === "create") {
        return t("fn.create");
    }

    return name || "";
}

function uiError(message) {
    const key = {
        "Request failed": "error.request",
        "invalid address": "error.invalidAddress",
        "account not found": "error.account",
        "transaction not found": "error.tx",
        "block not found": "error.block",
        "token not found": "error.token"
    }[message];
    return key ? t(key) : message;
}

function notice(status) {
    return banner(status && status.error ? t("status.unavailable") : null);
}

async function api(path) {
    const response = await fetch(path);
    const body = await response.json();

    if (!response.ok) {
        throw new Error(body.error || "Request failed");
    }

    return body;
}

function parseHash() {
    const raw = location.hash || "#/";
    const [path, query] = raw.split("?");
    return { path, params: new URLSearchParams(query || "") };
}

function pageNumbers(page, pages) {
    if (pages <= 7) {
        return Array.from({ length: pages }, (_, index) => index + 1);
    }

    const items = [1];
    const left = Math.max(2, page - 1);
    const right = Math.min(pages - 1, page + 1);

    if (left > 2) {
        items.push(0);
    }

    for (let number = left; number <= right; number += 1) {
        items.push(number);
    }

    if (right < pages - 1) {
        items.push(0);
    }

    items.push(pages);
    return items;
}

function listPager(data, hrefFor, place) {
    const pages = Math.max(1, Math.ceil((data.total || 0) / (data.limit || 1)));
    const page = Math.min(pages, Math.max(1, data.page || 1));
    const start = data.total === 0 ? 0 : (page - 1) * data.limit + 1;
    const end = Math.min(data.total, page * data.limit);
    const button = (label, attrs) => el("button", { type: "button", ...attrs }, label);
    const open = (next) => {
        const target = hrefFor(next);

        if (typeof target === "string") {
            location.hash = target;
        }
    };

    return el("div", { class: "pager" + (place ? " pager-" + place : "") }, [
        el("span", {}, data.total ? t("pager.range", { start, end, total: data.total }) : "0"),
        el("span", { class: "pages" }, [
            button(t("pager.prev"), page > 1 ? { onclick: () => open(page - 1) } : { disabled: "" }),
            ...pageNumbers(page, pages).map((number) => number === 0
                ? el("span", { class: "gap" }, "…")
                : button(String(number), number === page
                    ? { class: "current", "aria-current": "page" }
                    : { onclick: () => open(number) })),
            button(t("pager.next"), page < pages ? { onclick: () => open(page + 1) } : { disabled: "" })
        ])
    ]);
}

function compareValues(left, right) {
    const a = left == null ? "" : left;
    const b = right == null ? "" : right;

    if (typeof a === "bigint" || typeof b === "bigint") {
        const first = BigInt(a);
        const second = BigInt(b);
        return first < second ? -1 : first > second ? 1 : 0;
    }

    if (typeof a === "number" && typeof b === "number") {
        return a - b;
    }

    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function dataTable(columns, rows, options) {
    const settings = options || {};
    const key = settings.key || "";
    const saved = key ? tableStates.get(key) : null;
    let query = saved ? saved.query : "";
    let sortCol = saved ? saved.sortCol : (Number.isInteger(settings.sort) ? settings.sort : null);
    let sortDir = saved ? saved.sortDir : (settings.dir === "desc" ? -1 : 1);
    let page = saved ? saved.page : Math.max(1, Number(settings.page) || 1);
    const limit = 20;
    const root = el("div");
    const input = el("input", {
        type: "search",
        class: "table-search",
        placeholder: t("table.search"),
        "data-state": key,
        value: query,
        oninput: (event) => {
            query = event.target.value;
            page = 1;
            remember();
            paint();
        }
    });
    input.value = query;

    function remember() {
        if (key) {
            tableStates.set(key, { query, sortCol, sortDir, page });
        }
    }
    const host = el("div");
    // compact: a short table (one page) without search and pager, scrolling sideways when narrow
    const compact = settings.compact && rows.length <= limit;
    if (!compact) {
        root.append(el("div", { class: "table-bar" }, input));
    }
    root.append(host);

    function paint() {
        const needle = query.trim().toLowerCase();
        let list = rows.filter((row) => {
            if (!needle) {
                return true;
            }

            return columns.some((column) => String(column.search ? column.search(row) : column.sort(row)).toLowerCase().includes(needle));
        });

        if (sortCol != null) {
            const column = columns[sortCol];
            list = list.slice().sort((a, b) => compareValues(column.sort(a), column.sort(b)) * sortDir);
        }

        const pages = Math.max(1, Math.ceil(list.length / limit));
        page = Math.min(page, pages);
        const start = (page - 1) * limit;
        const visible = list.slice(start, start + limit);
        const head = el("tr");

        columns.forEach((column, index) => {
            const mark = sortCol === index ? (sortDir === 1 ? " ▲" : " ▼") : "";
            head.append(el("th", {}, el("button", {
                type: "button",
                class: "sort" + (sortCol === index ? " on" : ""),
                onclick: () => {
                    if (sortCol === index) {
                        sortDir = -sortDir;
                    } else {
                        sortCol = index;
                        sortDir = 1;
                    }
                    remember();
                    paint();
                }
            }, t(column.label) + mark)));
        });

        const body = el("tbody");

        if (!visible.length) {
            body.append(el("tr", {}, el("td", { colspan: String(columns.length), class: "empty" }, t("table.none"))));
        } else {
            for (const row of visible) {
                body.append(el("tr", {}, columns.map((column) => el("td", {}, column.cell(row)))));
            }
        }

        const table = el("table", {}, [el("thead", {}, head), body]);
        const turn = (next) => {
            page = next;
            remember();
            paint();
        };
        const pager = (place) => listPager({
            total: list.length,
            limit,
            page
        }, turn, place);
        if (compact) {
            host.replaceChildren(el("div", { class: "table-scroll" }, table));
        } else {
            host.replaceChildren(pager("top"), table, pager());
        }
        remember();
    }

    paint();
    return root;
}

function txTo(tx) {
    if (tx.to) {
        return tx.toLabel ? contractLink(tx.toLabel, tx.to, "#/contracts/" + tx.to) : addr(tx.to);
    }

    return tx.contractAddress ? ident(tx.contractAddress, "#/transactions?address=" + tx.contractAddress) : el("span", {}, "—");
}

function isImageUrl(url) {
    return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i.test(url);
}

function memoImage(url) {
    const image = el("img", { class: "memo-image", src: url, alt: "" });
    image.addEventListener("error", () => {
        image.replaceWith(el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url));
    });
    return image;
}

function memoUrl(url) {
    if (!isImageUrl(url)) {
        return el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url);
    }

    return memoImage(url);
}

function memoNodes(memo) {
    // NFT payment memos end in the NFT's image URL: show the image, full memo as tooltip
    const mint = memo.match(/^(?:New NFT Token mint|NFT transfer|NFT buy|Avatar buy): [\s\S]* - (https?:\/\/\S+)$/);

    if (mint && isImageUrl(mint[1])) {
        return [addressTip(memoImage(mint[1]), [{ value: memo, copy: false }])];
    }

    const nodes = [];
    const pattern = /https?:\/\/[^\s<>"']+/g;
    let last = 0;
    let match;

    while ((match = pattern.exec(memo))) {
        if (match.index > last) {
            nodes.push(memo.slice(last, match.index));
        }

        nodes.push(memoUrl(match[0]));
        last = match.index + match[0].length;
    }

    if (last < memo.length) {
        nodes.push(memo.slice(last));
    }

    return nodes;
}

function txColumns() {
    return [
        { label: "col.hash", sort: (tx) => tx.hash, cell: (tx) => ident(tx.hash, "#/transactions/" + tx.hash) },
        { label: "col.type", sort: (tx) => tx.type, search: (tx) => tx.type + " " + t(tx.type === "call" ? "tx.call" : (tx.type === "create" ? "tx.create" : "tx.transfer")), cell: (tx) => badge(tx.type) },
        { label: "col.function", sort: (tx) => tx.functionName || "", search: (tx) => (tx.functionName || "") + " " + fnLabel(tx.functionName), cell: (tx) => fnLabel(tx.functionName) },
        { label: "col.from", sort: (tx) => tx.from, cell: (tx) => addr(tx.from) },
        { label: "col.to", sort: (tx) => tx.toLabel || tx.to || tx.contractAddress || "", search: (tx) => [tx.to, tx.toLabel, tx.contractAddress].filter(Boolean).join(" "), cell: (tx) => txTo(tx) },
        { label: "col.value", sort: (tx) => BigInt(tx.valueWei || 0), search: (tx) => tx.value + " ETH", cell: (tx) => tx.value + " ETH" },
        { label: "col.memo", sort: (tx) => tx.memo || "", search: (tx) => tx.memo || "", cell: (tx) => {
            const memo = tx.type === "transfer" || tx.functionName === "buy" ? (tx.memo || "") : "";
            return el("span", { class: "memo-cell" }, memo ? memoNodes(memo) : "—");
        } },
        { label: "col.time", sort: (tx) => tx.timestamp || 0, search: (tx) => stamp(tx.timestamp), cell: (tx) => stamp(tx.timestamp) }
    ];
}

function txTable(rows, key) {
    return dataTable(txColumns(), rows, { sort: 7, dir: "desc", key: key || "txs" });
}

function show(node) {
    let focus = null;
    const y = window.scrollY;

    if (showRefresh) {
        const active = document.activeElement;

        if (active && active.classList && active.classList.contains("table-search")) {
            focus = {
                key: active.getAttribute("data-state") || "",
                start: active.selectionStart,
                end: active.selectionEnd
            };
        }
    }

    view.replaceChildren(node);
    viewReady = true;
    shownHash = location.hash;

    if (!showRefresh) {
        return;
    }

    window.scrollTo(0, y);

    if (focus && focus.key) {
        const input = view.querySelector('.table-search[data-state="' + focus.key + '"]');

        if (input) {
            input.focus({ preventScroll: true });

            if (focus.start != null) {
                input.setSelectionRange(focus.start, focus.end);
            }
        }
    }
}

function banner(text) {
    return text ? el("div", { class: "banner" }, text) : null;
}

function formatCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        return "0";
    }
    return number.toLocaleString(getLocale() === "zh" ? "zh-CN" : "en-US");
}

function syncPercent(status) {
    const head = Number(status.head) || 0;
    const indexed = Number(status.indexed);

    if (status.error || head <= 0 || indexed < 0) {
        return 0;
    }

    return Math.max(0, Math.min(100, Math.round((indexed / head) * 100)));
}

function paintStatus(status) {
    const head = Number(status.head) || 0;
    const indexed = Number(status.indexed);
    const percent = syncPercent(status);
    const dot = document.querySelector("#status-dot");
    dot.className = status.error ? "bad" : (percent < 100 ? "sync" : "");
    document.querySelector("#status-text").textContent = status.error ? t("status.unavailable") : (status.ready ? t("status.title") : t("status.syncing"));
    document.querySelector("#status-pct").textContent = percent + "%";
    document.querySelector("#status-bar").style.width = percent + "%";
    document.querySelector("#status-head").textContent = formatCount(head);
    document.querySelector("#status-indexed").textContent = formatCount(indexed);
}

function noteStatus(status) {
    paintStatus(status);
    statusSig = [status.ready, status.error || "", status.head, status.indexed, status.transactions, status.accounts, status.contracts, status.nfts, status.peers].join("|");
}

function skipRefresh() {
    if (document.hidden || /^#\/(contracts\/0x|deploy|sections)/.test(location.hash)) {
        return true;
    }

    const active = document.activeElement;

    if (active && (active.tagName === "SELECT" || active.classList.contains("table-search") || active.closest(".filter-pop, .chart-range"))) {
        return true;
    }

    if (document.querySelector(".filter-pop:not([hidden])")) {
        return true;
    }

    const selection = document.getSelection();

    if (selection && !selection.isCollapsed && selection.anchorNode && view.contains(selection.anchorNode)) {
        return true;
    }

    return Boolean(document.querySelector(".tip-pop:not([hidden])"));
}

async function poll() {
    try {
        const status = await api("/api/status");
        const sig = [status.ready, status.error || "", status.head, status.indexed, status.transactions, status.accounts, status.contracts, status.nfts, status.peers].join("|");
        const previous = statusSig;
        const changed = sig !== previous;
        noteStatus(status);

        if (changed && previous && viewReady) {
            viewDirty = true;
        }

        if (!viewReady || skipRefresh() || rendering) {
            return;
        }

        if (viewDirty || Date.now() - lastViewRefresh > 30000) {
            viewDirty = false;
            lastViewRefresh = Date.now();
            render({ refresh: true });
        }
    } catch (error) {
        paintStatus({ error: error.message, head: 0, indexed: -1, ready: false });
    }
}

setInterval(poll, 2000);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        poll();
    }
});

async function render(options) {
    const refreshRequested = Boolean(options && options.refresh);

    if (refreshRequested && rendering) {
        viewDirty = true;
        return;
    }

    rendering = true;
    const token = ++showToken;
    const refresh = refreshRequested && viewReady && location.hash === shownHash;
    showRefresh = refresh;

    if (!refresh) {
        tableStates.clear();
        pageTab = "";
        txTab = "function";
        enodeOpen = false;
    }

    const { path, params } = parseHash();
    const page = Number(params.get("page") || 1);
    markNav(path);

    try {
        const status = await api("/api/status");

        if (token !== showToken) {
            return;
        }

        noteStatus(status);

        if (path === "#/" || path === "") {
            return showDashboard(status);
        }

        if (path === "#/accounts") {
            return showAccounts(page, status);
        }

        const account = path.match(/^#\/accounts\/(0x[0-9a-fA-F]{40})$/);
        if (account) {
            return showAccount(account[1]);
        }

        if (path === "#/nfts") {
            return showNfts(page, status);
        }

        const nft = path.match(/^#\/nfts\/(0x[0-9a-fA-F]{40})\/(\d+)$/);
        if (nft) {
            return showNft(nft[1], nft[2]);
        }

        if (path === "#/contracts") {
            return showContracts(page, params.get("type") || "all", status);
        }

        if (path === "#/deploy") {
            return showDeploy();
        }

        if (path === "#/sections") {
            return showSections();
        }

        if (path === "#/nicknames") {
            return showNicknames(params.get("q") || "");
        }

        const sectionPage = path.match(/^#\/sections\/(\d+)$/);
        if (sectionPage) {
            return showSection(sectionPage[1]);
        }

        const contract = path.match(/^#\/contracts\/(0x[0-9a-fA-F]{40})$/);
        if (contract) {
            return showContract(contract[1]);
        }

        if (path === "#/transactions") {
            return showTxs(page, status);
        }

        const tx = path.match(/^#\/transactions\/(0x[0-9a-fA-F]{64})$/);
        if (tx) {
            return showTx(tx[1]);
        }

        if (path === "#/blocks") {
            return showBlocks(page, status);
        }

        const block = path.match(/^#\/blocks\/(\d+)$/);
        if (block) {
            return showBlock(block[1]);
        }

        if (path === "#/network") {
            return showNetwork();
        }

        if (path === "#/api") {
            return showApi();
        }

        show(el("div", { class: "card" }, t("page.missing")));
    } catch (error) {
        if (token !== showToken) {
            return;
        }

        show(el("div", { class: "card" }, uiError(error.message)));
    } finally {
        if (token === showToken) {
            rendering = false;

            if (viewDirty && viewReady && location.hash === shownHash && !skipRefresh()) {
                viewDirty = false;
                lastViewRefresh = Date.now();
                render({ refresh: true });
            }
        }
    }
}

function markNav(path) {
    for (const link of nav.querySelectorAll("a")) {
        const href = link.getAttribute("href");
        link.classList.toggle("active", href === path || (href !== "#/" && path.startsWith(href)));
    }
}

function parseIsoDay(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
}

function chartSpanDays(start, end) {
    return Math.max(1, Math.round((parseIsoDay(end) - parseIsoDay(start)) / 86400000) + 1);
}

function nextChartSpan(span, expand) {
    if (expand) {
        return Math.max(span + 1, Math.round(span * 1.5));
    }

    if (span <= 1) {
        return 1;
    }

    const smaller = Math.round(span / 1.5);
    return Math.max(1, smaller === span ? span - 1 : smaller);
}

function setChartDuration(days) {
    const end = parseIsoDay(chartEnd);
    const start = new Date(end);
    const earliest = new Date(1970, 0, 1);
    start.setDate(end.getDate() - (days - 1));

    if (start < earliest) {
        start.setTime(earliest.getTime());
    }

    const nextStart = isoDay(start);

    if (nextStart === chartStart) {
        return;
    }

    chartStart = nextStart;
    chartAnimate = true;
    render({ refresh: true });
}

function queueChartDuration(deltaY) {
    chartWheel += deltaY;
    clearTimeout(chartWheelTimer);
    chartWheelTimer = setTimeout(() => {
        const delta = chartWheel;
        chartWheel = 0;

        if (!delta) {
            return;
        }

        const span = chartSpanDays(chartStart, chartEnd);
        const next = nextChartSpan(span, delta > 0);

        if (next !== span) {
            setChartDuration(next);
        }
    }, 90);
}

function chartBucketLabel(bucket) {
    if (Number.isInteger(bucket.hour)) {
        return t(bucket.hour >= 12 ? "time.pm" : "time.am", { hour: bucket.hour % 12 || 12 });
    }

    return bucket.label || "";
}

function chartAxis(max) {
    const safe = Math.max(1, max);
    const rough = safe / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
    const ratio = rough / magnitude;
    const step = Math.max(1, (ratio >= 7.5 ? 10 : ratio >= 3.5 ? 5 : ratio >= 1.5 ? 2 : 1) * magnitude);
    const axisMax = Math.ceil(safe / step) * step;
    const ticks = [];

    for (let value = 0; value <= axisMax; value += step) {
        ticks.push(value);
    }

    return { axisMax, ticks };
}

function chartBar(bucket, percent) {
    const parts = [];

    if (bucket.transfer) {
        parts.push(el("span", { class: "transfer", style: "flex:" + bucket.transfer }));
    }

    if (bucket.create) {
        parts.push(el("span", { class: "create", style: "flex:" + bucket.create }));
    }

    if (bucket.call) {
        parts.push(el("span", { class: "call", style: "flex:" + bucket.call }));
    }

    return el("div", { class: "bar", style: "height:" + (parts.length ? percent.toFixed(2) : "0") + "%" }, parts);
}

// ---- Platform overview on the dashboard (docs/features/sections.md): system accounts, contracts, sections.
// Charts follow the dataviz rules: categorical slots 1-3 (validated), one axis, thin bars with a 2px
// gap and a 4px rounded end, value labels at the bar ends, a hover tooltip per row, a table view.
function ethText(value) {
    if (value === null || value === undefined) {
        return "—";
    }
    return Number(value).toLocaleString(getLocale() === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 2 });
}

function idCard(label, value, unit, lines, accent) {
    return el("div", { class: "id-card" + (accent ? " accent" : "") }, [
        el("div", { class: "id-label" }, label),
        el("div", { class: "id-value" }, [el("b", {}, value), unit ? el("span", {}, " " + unit) : null]),
        ...lines.filter(Boolean).map((line) => el("div", { class: "id-line" }, line))
    ]);
}

let vizTip = null;

function showVizTip(event, rows) {
    if (!vizTip) {
        vizTip = el("div", { class: "viz-tip", role: "tooltip" });
        document.body.append(vizTip);
    }
    vizTip.replaceChildren(...rows.map(([key, value, swatch]) => el("div", { class: "viz-tip-row" }, [
        swatch ? el("i", { class: "viz-swatch " + swatch }) : null,
        el("span", {}, key),
        value !== undefined ? el("b", {}, value) : null
    ])));
    vizTip.hidden = false;
    const x = Math.min(event.clientX + 14, window.innerWidth - vizTip.offsetWidth - 8);
    const y = Math.min(event.clientY + 14, window.innerHeight - vizTip.offsetHeight - 8);
    vizTip.style.left = x + "px";
    vizTip.style.top = y + "px";
}

function hideVizTip() {
    if (vizTip) {
        vizTip.hidden = true;
    }
}

const ROLE_SLOTS = [["upfront", "s1"], ["consumption", "s2"], ["payment", "s3"]];
// the section's money in its user accounts: a neutral gray after the three role hues
const BALANCE_SLOTS = [...ROLE_SLOTS, ["users", "s0"]];

function balanceLabel(key) {
    return key === "users" ? t("platform.usersSeg") : t("role." + key);
}

function balanceChart(sections) {
    const totals = sections.map((s) => BALANCE_SLOTS.reduce((sum, [role]) => sum + (s.balances[role] || 0), 0));
    const max = Math.max(0, ...totals);
    const rows = sections.map((s, i) => {
        const segments = BALANCE_SLOTS.map(([role, slot]) => {
            const v = s.balances[role] || 0;
            return v > 0 && max > 0 ? el("i", { class: "viz-seg " + slot, style: "width:" + (v / max * 100) + "%" }) : null;
        }).filter(Boolean);
        // upfront / consumption / payment / users, in the legend's order
        const parts = [];
        BALANCE_SLOTS.forEach(([role], j) => {
            if (j) {
                parts.push(el("span", { class: "viz-sep" }, "/"));
            }
            parts.push(el("span", {}, ethText(s.balances[role] || 0)));
        });
        const row = el("div", { class: "viz-row" + (s.active ? "" : " off") }, [
            el("a", { class: "viz-name", href: "#/accounts?section=" + encodeURIComponent("s:" + s.name) }, s.name),
            el("div", { class: "viz-track" }, [el("div", { class: "viz-bar" }, segments), el("span", { class: "viz-end viz-parts" }, parts)])
        ]);
        row.addEventListener("mousemove", (event) => showVizTip(event, [
            [s.name + (s.active ? "" : " (" + t("sections.disabled") + ")")],
            ...BALANCE_SLOTS.map(([role, slot]) => [balanceLabel(role), ethText(s.balances[role]) + " ETH", slot]),
            [t("platform.total"), ethText(totals[i]) + " ETH"]
        ]));
        row.addEventListener("mouseleave", hideVizTip);
        return row;
    });
    return el("div", { class: "viz" }, rows);
}

function usersChart(sections) {
    const max = Math.max(0, ...sections.map((s) => s.users));
    return el("div", { class: "viz" }, sections.map((s) => {
        const row = el("div", { class: "viz-row" + (s.active ? "" : " off") }, [
            el("a", { class: "viz-name", href: "#/accounts?section=" + encodeURIComponent("s:" + s.name) }, s.name),
            el("div", { class: "viz-track" }, [
                el("div", { class: "viz-bar" }, s.users > 0 ? [el("i", { class: "viz-seg s1", style: "width:" + (s.users / max * 100) + "%" })] : []),
                el("span", { class: "viz-end" }, formatCount(s.users))
            ])
        ]);
        row.addEventListener("mousemove", (event) => showVizTip(event, [[s.name], [t("platform.userAccounts"), formatCount(s.users), "s1"]]));
        row.addEventListener("mouseleave", hideVizTip);
        return row;
    }));
}

function vizLegend() {
    return el("div", { class: "viz-legend" }, BALANCE_SLOTS.map(([role, slot]) => el("span", {}, [el("i", { class: "viz-swatch " + slot }), balanceLabel(role)])));
}

function balancesTable(sections) {
    return dataTable([
        { label: "col.section", sort: (row) => row.name, cell: (row) => row.name },
        { label: "role.upfront", sort: (row) => row.balances.upfront || 0, cell: (row) => ethText(row.balances.upfront) },
        { label: "role.consumption", sort: (row) => row.balances.consumption || 0, cell: (row) => ethText(row.balances.consumption) },
        { label: "role.payment", sort: (row) => row.balances.payment || 0, cell: (row) => ethText(row.balances.payment) },
        { label: "platform.usersSeg", sort: (row) => row.balances.users || 0, cell: (row) => ethText(row.balances.users) },
        { label: "platform.userAccounts", sort: (row) => row.users, cell: (row) => formatCount(row.users) }
    ], sections, { key: "platform-balances" });
}


// ---- Section statistics: week / month / quarter / year (/api/sections/stats). One measure at a time
// in a column chart (one series, one axis); click a column for that period's table by section.
const STAT_UNITS = { newUsers: "count", avatarSales: "count", nicknameSales: "count", levelUpgrades: "count", txs: "count" };
const STAT_COLUMNS = ["newUsers", "income", "fromUsers", "avatarSales", "avatarEth", "nicknameSales", "levelUpgrades", "nicknameEth", "refunds", "toUsers", "topup", "sweep", "payback", "txs"];
const statState = { period: "month", section: "all", metric: "balances", index: null, from: "", to: "" };

function statQuery() {
    return "period=" + statState.period + (statState.from && statState.to ? "&from=" + statState.from + "&to=" + statState.to : "");
}
const statCache = new Map(); // period -> the last answer (drawn at once on the dashboard's refresh)

function statValue(value, metric) {
    return STAT_UNITS[metric] === "count" ? formatCount(value) : ethText(value);
}

function statSum(stats, metric, index) {
    return stats.sections
        .filter((s) => statState.section === "all" || String(s.id) === statState.section)
        .reduce((sum, s) => sum + (metric.startsWith("bal:")
            ? (s.values[index].balances || {})[metric.slice(4)] || 0
            : metric === "balances"
                ? BALANCE_SLOTS.reduce((t2, [role]) => t2 + ((s.values[index].balances || {})[role] || 0), 0)
                : s.values[index][metric]), 0);
}

// one stacked column (bottom to top: upfront, consumption, payment, users), as the balance bars
function balanceColumn(stats, i, max) {
    // the stack's height is the total (like a single bar); the segments share it by value
    let total = 0;
    const segments = BALANCE_SLOTS.map(([role, slot]) => {
        const v = statSum(stats, "bal:" + role, i);
        total += v > 0 ? v : 0;
        return v > 0 ? el("i", { class: "col-seg " + slot, style: "flex:" + v + " 0 0" }) : null;
    }).filter(Boolean);
    return el("span", { class: "col-stack", style: "height:" + (max > 0 ? total / max * 100 : 0) + "%" }, segments);
}

function statsCard() {
    const holder = el("section", { class: "card stack stats-card" });
    const load = async () => {
        const query = statQuery();
        const cached = statCache.get(query);
        if (cached) {
            render(cached);
        }
        try {
            const stats = await api("/api/sections/stats?" + query);
            statCache.set(query, stats);
            if (query === statQuery() && holder.isConnected) {
                render(stats);
            }
        } catch (error) {
            if (!cached) {
                holder.replaceChildren(el("div", { class: "empty" }, error.message));
            }
        }
    };
    const render = (stats) => {
        if (!stats.sections.length) {
            holder.remove();
            return;
        }
        if (statState.section !== "all" && !stats.sections.some((s) => String(s.id) === statState.section)) {
            statState.section = "all";
        }
        const last = stats.periods.length - 1;
        const index = statState.index === null || statState.index > last ? last : statState.index;
        const metric = statState.metric;

        const tabs = el("div", { class: "seg-tabs", role: "tablist" }, ["day", "week", "month", "quarter", "year"].map((p) => {
            const b = el("button", { type: "button", role: "tab", class: "seg-tab" + (p === statState.period ? " on" : ""), "aria-selected": String(p === statState.period) }, t("stats." + p));
            b.addEventListener("click", () => { statState.period = p; statState.index = null; load(); });
            return b;
        }));
        const sectionSelect = el("select", { "aria-label": t("col.section") }, [
            el("option", { value: "all" }, t("stats.allSections")),
            ...stats.sections.map((s) => el("option", { value: String(s.id) }, s.name))
        ]);
        sectionSelect.value = statState.section;
        sectionSelect.addEventListener("change", () => { statState.section = sectionSelect.value; load(); });
        // duration: a date range (UTC days); empty = the last periods
        const today = new Date().toISOString().slice(0, 10);
        const fromInput = el("input", { type: "date", class: "stat-date", max: today, value: statState.from, "aria-label": t("dash.start") });
        const toInput = el("input", { type: "date", class: "stat-date", max: today, value: statState.to, "aria-label": t("dash.end") });
        const applyRange = () => {
            const from = fromInput.value;
            const to = toInput.value;
            if ((from && to && from <= to) || (!from && !to)) {
                statState.from = from;
                statState.to = to;
                statState.index = null;
                load();
            }
        };
        fromInput.addEventListener("change", applyRange);
        toInput.addEventListener("change", applyRange);
        const clearRange = el("button", { type: "button", class: "fn-run stat-clear" }, t("stats.lastPeriods"));
        clearRange.hidden = !statState.from;
        clearRange.addEventListener("click", () => { statState.from = ""; statState.to = ""; statState.index = null; load(); });
        const rangeRow = el("div", { class: "stat-range" }, [
            el("label", {}, [t("dash.start"), fromInput]),
            el("label", {}, [t("dash.end"), toInput]),
            clearRange,
            el("span", { class: "muted" }, stats.range
                ? t("stats.rangeShown").replace("{n}", String(stats.periods.length)) + (stats.truncated ? " " + t("stats.truncated") : "")
                : t("stats.lastShown").replace("{n}", String(stats.periods.length)))
        ]);
        const metricSelect = el("select", { "aria-label": t("stats.measure") }, ["balances", ...STAT_COLUMNS].map((m) => el("option", { value: m }, t("stats." + m))));
        const stacked = metric === "balances";
        metricSelect.value = metric;
        metricSelect.addEventListener("change", () => { statState.metric = metricSelect.value; load(); });

        // column chart of the measure per period
        const sums = stats.periods.map((p, i) => statSum(stats, metric, i));
        const max = Math.max(0, ...sums);
        const peak = sums.indexOf(max);
        const columns = el("div", { class: "col-chart", role: "img", "aria-label": t("stats." + metric) },
            stats.periods.map((p, i) => {
                const label = i === index || (i === peak && max > 0) ? statValue(sums[i], metric) : "";
                const col = el("button", { type: "button", class: "col" + (i === index ? " on" : ""), "aria-label": p.label + ": " + statValue(sums[i], metric) }, [
                    el("span", { class: "col-value" }, label),
                    el("span", { class: "col-track" }, [stacked ? balanceColumn(stats, i, max)
                        : el("i", { class: "col-bar", style: "height:" + (max > 0 ? Math.max(sums[i] > 0 ? 2 : 0, sums[i] / max * 100) : 0) + "%" })]),
                    el("span", { class: "col-label" }, p.label)
                ]);
                col.addEventListener("click", () => { statState.index = i; load(); });
                col.addEventListener("mousemove", (event) => showVizTip(event, [
                    [p.label + (statState.section === "all" ? "" : " · " + sectionSelect.selectedOptions[0].textContent)],
                    ...(stacked
                        ? [...BALANCE_SLOTS.slice().reverse().map(([role, slot]) => [balanceLabel(role), ethText(statSum(stats, "bal:" + role, i)) + " ETH", slot]),
                            [t("platform.total"), ethText(sums[i]) + " ETH"]]
                        : STAT_COLUMNS.map((m) => [t("stats." + m), statValue(statSum(stats, m, i), m), m === metric ? "s1" : null]))
                ]));
                col.addEventListener("mouseleave", hideVizTip);
                return col;
            }));

        // the selected period, by section
        const rows = stats.sections
            .filter((s) => statState.section === "all" || String(s.id) === statState.section)
            .map((s) => Object.assign({ name: s.name }, s.values[index]));
        const balanceTotal = (r) => BALANCE_SLOTS.reduce((sum, [role]) => sum + ((r.balances || {})[role] || 0), 0);
        const table = stacked
            ? dataTable([
                { label: "col.section", sort: (r) => r.name, cell: (r) => r.name },
                ...BALANCE_SLOTS.map(([role]) => ({ label: role === "users" ? "platform.usersSeg" : "role." + role, sort: (r) => (r.balances || {})[role] || 0, cell: (r) => ethText((r.balances || {})[role] || 0) })),
                { label: "platform.total", sort: balanceTotal, cell: (r) => ethText(balanceTotal(r)) }
            ], rows, { key: "section-stats-balances", compact: true })
            : dataTable([
                { label: "col.section", sort: (r) => r.name, cell: (r) => r.name },
                ...STAT_COLUMNS.map((m) => ({ label: "stats." + m, sort: (r) => r[m], cell: (r) => statValue(r[m], m) }))
            ], rows, { key: "section-stats", compact: true });
        const totals = stacked
            ? el("div", { class: "stat-totals" }, [
                ...BALANCE_SLOTS.map(([role, slot]) => el("div", { class: "stat-total" }, [
                    el("span", {}, [el("i", { class: "viz-swatch " + slot }), " " + balanceLabel(role) + " (ETH)"]), el("b", {}, ethText(statSum(stats, "bal:" + role, index)))])),
                el("div", { class: "stat-total on" }, [el("span", {}, t("platform.total") + " (ETH)"), el("b", {}, ethText(sums[index]))])
            ])
            : el("div", { class: "stat-totals" }, STAT_COLUMNS.slice(0, 6).map((m) =>
                el("div", { class: "stat-total" + (m === metric ? " on" : "") }, [el("span", {}, t("stats." + m)), el("b", {}, statValue(statSum(stats, m, index), m))])));

        holder.replaceChildren(
            el("div", { class: "card-head" }, [el("h2", {}, t("stats.title")), el("div", { class: "stat-controls" }, [tabs, sectionSelect, metricSelect])]),
            rangeRow,
            el("div", { class: "muted stat-note" }, t(stacked ? "stats.noteBalances" : "stats.note")),
            stacked ? vizLegend() : null,
            columns,
            el("h3", { class: "stat-period" }, stats.periods[index].label + (statState.section === "all" ? "" : " · " + sectionSelect.selectedOptions[0].textContent)),
            totals,
            table
        );
    };
    if (!statCache.has(statQuery())) {
        holder.append(el("div", { class: "muted" }, "…"));
    }
    load();
    return holder;
}

let platformTableView = false;

function platformSection(o) {
    if (!o || (!o.sender01 && !o.registry)) {
        return null;
    }
    const c = o.sectionCounts;
    const cards = el("div", { class: "id-cards" }, [
        o.sender01 ? idCard(t("role.sender01"), ethText(o.sender01.balance), "ETH",
            [addr(o.sender01.address), t("platform.sender01Note")], true) : null,
        o.center ? idCard(t("role.contract center"), formatCount(o.center.contracts), t("platform.contracts"),
            [t("platform.kinds").replace("{common}", formatCount(o.center.common)).replace("{nft}", formatCount(o.center.nft)), addr(o.center.address)]) : null,
        o.registry ? idCard(t("platform.registry"), formatCount(c.total), t("platform.sectionsUnit"),
            [el("span", {}, [t("platform.contract") + " ", addr(o.registry.address, "#/contracts/" + o.registry.address)]),
                o.registry.admin ? el("span", {}, [t("role.registry admin") + " ", addr(o.registry.admin)]) : null]) : null,
        idCard(t("sections.title"), formatCount(c.active), t("sections.active"),
            [t("platform.sectionStates").replace("{disabled}", formatCount(c.disabled)).replace("{archived}", formatCount(c.archived)),
                t("platform.usersLine").replace("{users}", formatCount(c.users)).replace("{inSections}", formatCount(o.accounts.inSections)).replace("{indexed}", formatCount(o.accounts.indexed))])
    ]);
    const body = el("div");
    const toggle = el("button", { type: "button", class: "fn-run viz-toggle" });
    const draw = () => {
        toggle.textContent = platformTableView ? t("platform.chartView") : t("platform.tableView");
        body.replaceChildren(...(o.sections.length
            ? (platformTableView
                ? [balancesTable(o.sections)]
                : [el("div", { class: "split" }, [
                    el("div", {}, [el("h3", {}, t("platform.balances")), vizLegend(), balanceChart(o.sections)]),
                    // an empty legend line, so both charts' rows line up
                    el("div", {}, [el("h3", {}, t("platform.userAccounts")), el("div", { class: "viz-legend", "aria-hidden": "true" }, "\u00a0"), usersChart(o.sections)])
                ])])
            : [el("div", { class: "empty" }, t("sections.none"))]));
    };
    toggle.addEventListener("click", () => { platformTableView = !platformTableView; draw(); });
    draw();
    return el("section", { class: "platform" }, [
        el("div", { class: "card-head" }, [
            el("h2", {}, t("platform.title")),
            el("span", { class: "muted" }, t("platform.updated") + " " + (o.updatedAt ? new Date(o.updatedAt).toLocaleTimeString() : "—"))
        ]),
        cards,
        el("section", { class: "card stack" }, [
            el("div", { class: "card-head" }, [el("h2", {}, t("platform.sections")), toggle]),
            body
        ])
    ]);
}

async function showDashboard(status) {
    const token = showToken;
    const [data, platform] = await Promise.all([
        api("/api/dashboard?from=" + encodeURIComponent(chartStart) + "&to=" + encodeURIComponent(chartEnd)),
        api("/api/overview").catch(() => null)
    ]);

    if (token !== showToken) {
        return;
    }
    const totals = data.chart.map((bucket) => bucket.transfer + bucket.call + bucket.create);
    const axis = chartAxis(Math.max(0, ...totals));
    const periodTotal = totals.reduce((sum, value) => sum + value, 0);
    const hourly = Number.isInteger(data.chart[0] && data.chart[0].hour);
    const step = hourly ? 3 : (data.chart.length > 14 ? Math.ceil(data.chart.length / 8) : 1);
    const chart = el("div", { class: "chart" + (data.chart.length > 14 ? " compact" : "") });
    const grid = el("div", { class: "chart-grid" });

    axis.ticks.forEach((tick) => {
        if (tick > 0) {
            grid.append(el("i", { style: "bottom:" + (tick / axis.axisMax * 100) + "%" }));
        }
    });
    chart.append(grid);

    data.chart.forEach((bucket, index) => {
        const total = totals[index];
        const label = chartBucketLabel(bucket);
        const showLabel = index % step === 0 || index === data.chart.length - 1;
        const tip = label + " · " + t("tx.transfer") + " " + bucket.transfer + " · " + t("tx.call") + " " + bucket.call + " · " + t("tx.create") + " " + bucket.create;
        chart.append(el("div", { class: "bar-wrap", title: tip }, [
            el("div", { class: "bar-slot" }, chartBar(bucket, total / axis.axisMax * 100)),
            el("em", {}, showLabel ? label : "")
        ]));
    });
    const plot = el("div", {
        class: "chart-plot" + (chartAnimate ? " animate" : ""),
        "aria-label": t("dash.resize")
    }, [
        el("div", { class: "y-axis" }, axis.ticks.map((tick) => el("span", { style: "bottom:" + (tick / axis.axisMax * 100) + "%" }, formatCount(tick)))),
        chart
    ]);
    chartAnimate = false;
    plot.addEventListener("wheel", (event) => {
        if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) {
            return;
        }

        event.preventDefault();
        queueChartDuration(event.deltaY);
    }, { passive: false });
    const applyDates = () => {
        let start = startInput.value;
        let end = endInput.value;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
            return;
        }

        if (start > end) {
            const swap = start;
            start = end;
            end = swap;
        }

        if (start === chartStart && end === chartEnd) {
            return;
        }

        chartStart = start;
        chartEnd = end;
        chartAnimate = true;
        render({ refresh: true });
    };
    const startInput = el("input", { type: "date", "aria-label": t("dash.start"), value: chartStart, onchange: applyDates });
    const endInput = el("input", { type: "date", "aria-label": t("dash.end"), value: chartEnd, onchange: applyDates });
    const legend = el("div", { class: "chart-legend" }, [
        el("span", {}, [el("i", { class: "swatch transfer" }), t("tx.transfer")]),
        el("span", {}, [el("i", { class: "swatch call" }), t("tx.call")]),
        el("span", {}, [el("i", { class: "swatch create" }), t("tx.create")])
    ]);

    const contracts = dataTable([
        { label: "col.address", sort: (row) => row.label || row.address, search: (row) => row.label + " " + row.address, cell: (row) => contractLink(row.label, row.address, "#/contracts/" + row.address) },
        { label: "col.type", sort: (row) => row.type, cell: (row) => el("span", {}, [el("span", { class: "badge type" }, row.type), row.registered ? el("span", { class: "badge abi", title: t("contract.abiTip") }, "ABI") : null]) },
        { label: "col.txCount", sort: (row) => row.txCount || 0, cell: (row) => String(row.txCount) },
        { label: "col.created", sort: (row) => row.createdAt || 0, search: (row) => stamp(row.createdAt), cell: (row) => stamp(row.createdAt) }
    ], data.contractsActive, { sort: 2, dir: "desc", key: "dash-contracts" });
    const slices = data.pie.length ? data.pie : [{ kind: "empty", count: 0 }];
    const pieTotal = slices.reduce((sum, item) => sum + (item.count || 0), 0);
    let pieAt = 0;
    const pieStops = slices.filter((item) => item.count).map((item) => {
        const start = pieAt;
        pieAt += item.count / pieTotal * 100;
        const color = item.kind === "erc721" ? "var(--create)" : (item.kind === "erc20" ? "var(--transfer)" : "var(--type)");
        return color + " " + start.toFixed(2) + "% " + pieAt.toFixed(2) + "%";
    });
    const pie = el("div", { class: "pie-wrap" }, [
        el("div", { class: "pie", style: "background:" + (pieStops.length ? "conic-gradient(" + pieStops.join(",") + ")" : "var(--line)") }),
        ...slices.map((item) => el("div", { class: "legend" }, [
            el("i", { class: "swatch " + (item.kind || "empty") }),
            (item.kind && item.kind !== "empty" ? t("pie." + item.kind) : (item.label || t("dash.noTokens"))) + (item.count ? " - " + item.count : "")
        ]))
    ]);

    show(el("div", {}, [
        notice(status),
        el("section", { class: "stats" }, [
            stat(data.transactions, t("dash.txCreated")),
            stat(data.tokens, t("dash.tokens")),
            stat(data.contracts, t("dash.contracts")),
            stat(data.peers, t("dash.peers"))
        ]),
        platformSection(platform),
        platform && platform.sections && platform.sections.length ? statsCard() : null,
        el("section", { class: "card" }, [
            el("div", { class: "card-head" }, [el("h2", {}, t("dash.txCount")), el("div", { class: "chart-range" }, [
                el("label", {}, [t("dash.start"), startInput]),
                el("label", {}, [t("dash.end"), endInput])
            ])]),
            el("b", { class: "figure" }, String(periodTotal)),
            legend,
            data.chart.length ? plot : el("div", { class: "empty" }, t("dash.noneToday"))
        ]),
        el("section", { class: "split" }, [
            el("div", { class: "card" }, [el("h2", {}, t("dash.active")), contracts]),
            el("div", { class: "card" }, [el("h2", {}, t("dash.tokensTitle")), pie])
        ])
    ]));
}

function stat(value, label) {
    return el("div", { class: "stat" }, [el("b", {}, String(value)), el("span", {}, label)]);
}

// The section of an account (docs/features/sections.md): its name and role, or a special account's role
function sectionCell(row) {
    if (!row.role) {
        return el("span", { class: "muted" }, "—");
    }
    const badge = el("span", { class: "badge role role-" + row.role.replace(/\s+/g, "-"), title: t("role.help." + row.role) }, t("role." + row.role));
    if (!row.section) {
        return badge;
    }
    return el("span", { class: "section-cell" }, [
        el("span", { class: row.sectionArchived ? "muted" : "" }, row.section + (row.sectionArchived ? " (" + t("sections.archivedBadge") + ")" : "")),
        " ",
        badge
    ]);
}

async function showAccounts(page, status) {
    const token = showToken;
    const data = await api("/api/accounts?limit=20000");

    if (token !== showToken) {
        return;
    }
    // section filter: all, one section, no section, system accounts
    const { params } = parseHash();
    const filter = params.get("section") || "";
    const names = [...new Set(data.items.filter((row) => row.section).map((row) => row.section))].sort();
    const select = el("select", { "aria-label": t("col.section"), onchange: (event) => {
        location.hash = "#/accounts" + (event.target.value ? "?section=" + encodeURIComponent(event.target.value) : "");
    } }, [
        el("option", { value: "" }, t("accounts.allSections")),
        ...names.map((name) => el("option", { value: "s:" + name }, name)),
        el("option", { value: "none" }, t("accounts.noSection")),
        el("option", { value: "system" }, t("accounts.system"))
    ]);
    select.value = filter;
    const items = data.items.filter((row) => {
        if (!filter) return true;
        if (filter === "none") return !row.role;
        if (filter === "system") return row.role && !row.section;
        return filter.startsWith("s:") && row.section === filter.slice(2);
    });
    const table = dataTable([
        { label: "col.address", sort: (row) => row.address, cell: (row) => addr(row.address) },
        { label: "col.section", sort: (row) => (row.section || "") + " " + (row.role || ""), search: (row) => (row.section || "") + " " + (row.role ? t("role." + row.role) : ""), cell: sectionCell },
        { label: "col.balance", sort: (row) => BigInt(row.balanceWei || 0), search: (row) => row.balance, cell: (row) => row.balance },
        { label: "col.totalTokens", sort: (row) => row.tokens || 0, cell: (row) => String(row.tokens) },
        { label: "col.totalNfts", sort: (row) => row.nfts || 0, cell: (row) => String(row.nfts) },
        { label: "col.transactions", sort: (row) => row.transactions || 0, cell: (row) => String(row.transactions) }
    ], items, { sort: 2, dir: "desc", page, key: "accounts" + filter });
    show(el("section", { class: "card" }, [
        notice(status),
        el("div", { class: "card-head" }, [el("h2", {}, t("accounts.title")), select]),
        table
    ]));
}

async function showAccount(address) {
    const token = showToken;
    const data = await api("/api/accounts/" + address);

    if (token !== showToken) {
        return;
    }
    const panel = el("div");
    const tabs = el("div", { class: "tabs" });

    function draw(name) {
        pageTab = name;
        panel.replaceChildren();

        if (name === "transactions") {
            panel.append(data.transactionsList.length ? txTable(data.transactionsList, "acct-tx") : el("div", { class: "empty" }, t("account.noneTx")));
        } else if (name === "tokens") {
            panel.append(tokenTable(data.tokenList));
        } else {
            panel.append(nftTable(data.nftList));
        }

        for (const button of tabs.children) {
            button.classList.toggle("active", button.dataset.tab === name);
        }
    }

    for (const [id, label] of [["transactions", t("account.transactions")], ["tokens", t("account.tokens")], ["nfts", t("account.nfts")]]) {
        tabs.append(el("button", { type: "button", "data-tab": id, onclick: () => draw(id) }, label));
    }

    draw(pageTab || (data.nftList.length ? "nfts" : "transactions"));
    show(el("div", {}, [
        el("div", { class: "muted", style: "margin-bottom:10px" }, t("nav.accounts") + " / " + data.address),
        el("div", { class: "detail" }, [
            el("section", { class: "card" }, [
                el("h2", {}, t("account.details")),
                el("div", {}, addr(data.address, "#/accounts/" + data.address)),
                el("div", { style: "margin-top:8px" }, copyValue(data.address)),
                data.role ? el("div", { class: "account-section" }, [
                    el("span", { class: "muted" }, t("col.section") + " "),
                    sectionCell(data),
                    el("div", { class: "muted", style: "margin-top:4px" }, t("role.help." + data.role))
                ]) : null
            ]),
            el("aside", { class: "side-stat" }, [el("div", {}, t("account.balance")), el("b", {}, data.balance), "ETH"])
        ]),
        el("section", { class: "card stack" }, [tabs, panel])
    ]));
}

function tokenTable(rows) {
    if (!rows.length) {
        return el("div", { class: "empty" }, t("account.noneTokens"));
    }

    return dataTable([
        { label: "col.token", sort: (row) => row.address, cell: (row) => addr(row.address, "#/contracts") },
        { label: "col.name", sort: (row) => row.name || "", cell: (row) => row.name || "—" },
        { label: "col.symbol", sort: (row) => row.symbol || "", cell: (row) => row.symbol || "—" },
        { label: "col.type", sort: (row) => row.type || "", cell: (row) => el("span", { class: "badge type" }, row.type) }
    ], rows, { key: "acct-tokens" });
}

function nftTable(rows) {
    if (!rows.length) {
        return el("div", { class: "empty" }, t("account.noneNfts"));
    }

    return dataTable([
        { label: "col.tokenAddress", sort: (row) => row.contract, cell: (row) => ident(row.contract, "#/nfts/" + row.contract + "/" + row.tokenId) },
        { label: "col.collection", sort: (row) => row.collection || "", cell: (row) => row.collection },
        { label: "col.name", sort: (row) => row.name || "", cell: (row) => row.name || "—" },
        { label: "col.tokenId", sort: (row) => Number(row.tokenId) || 0, cell: (row) => row.tokenId },
        { label: "col.amount", sort: (row) => BigInt(row.amountWei || 0), search: (row) => (row.amount || "0") + " ETH", cell: (row) => (row.amount || "0") + " ETH" },
        { label: "col.type", sort: (row) => row.type || "", cell: (row) => el("span", { class: "badge type" }, row.type) }
    ], rows, { sort: 3, key: "acct-nfts" });
}

function nftSearchText(nft) {
    const traits = (nft.attributes || []).map((item) => item.trait_type + " " + item.value);
    const properties = Object.entries(nft.properties || {}).map(([key, value]) => key + " " + value);
    return [nft.name, nft.tokenId, nft.collection, nft.owner, nft.contract, nft.amount, nft.type, nft.description, ...traits, ...properties].join(" ");
}

async function showNfts(page, status) {
    const token = showToken;
    const data = await api("/api/nfts?limit=20000");

    if (token !== showToken) {
        return;
    }
    const saved = tableStates.get("nfts");
    let query = saved ? saved.query : "";
    const limit = 20;
    const grid = el("div", { class: "grid" });
    const pagerHost = el("div", { class: "nft-pager" });
    const pagerTail = el("div", { class: "nft-pager" });
    const empty = el("div", { class: "empty" });
    const input = el("input", {
        type: "search",
        class: "table-search",
        placeholder: t("nft.search"),
        "aria-label": t("nft.search"),
        "data-state": "nfts",
        value: query,
        oninput: (event) => {
            query = event.target.value;
            tableStates.set("nfts", { query });
            const hash = location.hash || "#/nfts";

            if (hash !== "#/nfts" && hash !== "#/nfts?page=1") {
                location.hash = "#/nfts";
                return;
            }

            paint();
        }
    });
    input.value = query;

    function paint() {
        const needle = query.trim().toLowerCase();
        const list = data.items.filter((nft) => !needle || nftSearchText(nft).toLowerCase().includes(needle));
        const pages = Math.max(1, Math.ceil(list.length / limit));
        const current = Math.min(pages, Math.max(1, page));
        const visible = list.slice((current - 1) * limit, current * limit);
        const cards = visible.map((nft) => {
            const media = nft.image ? el("img", { src: nft.image, alt: nft.name || "NFT" }) : el("div", { class: "ph" });
            return el("a", { class: "nft-card", href: "#/nfts/" + nft.contract + "/" + nft.tokenId }, [
                media,
                el("div", { class: "pad" }, [
                    el("h3", {}, nft.name || ("#" + nft.tokenId)),
                    el("div", { class: "muted" }, nft.collection),
                    el("div", {}, t("nft.token", { id: nft.tokenId })),
                    el("div", {}, (nft.amount || "0") + " ETH"),
                    el("div", {}, addr(nft.owner))
                ])
            ]);
        });

        grid.replaceChildren(...cards);
        grid.hidden = list.length === 0;
        empty.hidden = list.length > 0;
        empty.textContent = data.items.length ? t("table.none") : t("nft.none");
        const nftPager = () => listPager({
            total: list.length,
            limit,
            page: current
        }, (next) => next === 1 ? "#/nfts" : "#/nfts?page=" + next);
        pagerHost.replaceChildren(nftPager());
        pagerTail.replaceChildren(nftPager());
    }

    paint();
    show(el("section", { class: "card" }, [
        notice(status),
        el("h2", {}, t("nft.title")),
        el("div", { class: "nft-tools" }, [input, pagerHost]),
        empty,
        grid,
        pagerTail
    ]));
}

async function showNft(contract, tokenId) {
    const token = showToken;
    const nft = await api("/api/nfts/" + contract + "/" + tokenId);

    if (token !== showToken) {
        return;
    }
    const media = nft.image ? el("img", { src: nft.image, alt: nft.name || "NFT" }) : el("div", { class: "ph" });
    const facts = el("div", { class: "kv" }, [
        el("span", {}, t("nft.collection")), nft.collection,
        el("span", {}, t("nft.tokenId")), nft.tokenId,
        el("span", {}, t("nft.amount")), (nft.amount || "0") + " ETH",
        el("span", {}, t("nft.owner")), addr(nft.owner),
        el("span", {}, t("nft.type")), nft.type,
        el("span", {}, t("nft.contract")), copyValue(nft.contract)
    ]);

    if (nft.description) {
        facts.append(el("span", {}, t("nft.description")), el("span", {}, nft.description));
    }

    for (const attribute of nft.attributes || []) {
        const value = attribute.max_value === undefined || attribute.max_value === null || attribute.max_value === ""
            ? String(attribute.value)
            : String(attribute.value) + " / " + attribute.max_value;
        facts.append(el("span", {}, attribute.trait_type || t("nft.trait")), el("span", {}, value));
    }

    for (const [key, value] of Object.entries(nft.properties || {})) {
        facts.append(el("span", {}, key), el("span", {}, String(value)));
    }

    show(el("section", { class: "card" }, [
        el("h2", {}, nft.name || t("nft.heading", { id: nft.tokenId })),
        el("div", { class: "hero" }, [media, facts])
    ]));
}

async function showContracts(page, type, status) {
    const token = showToken;
    const data = await api("/api/contracts?limit=20000&type=" + encodeURIComponent(type));

    if (token !== showToken) {
        return;
    }
    const select = el("select", { onchange: (event) => { location.hash = "#/contracts?type=" + event.target.value; } }, [
        el("option", { value: "all" }, t("contracts.all")),
        el("option", { value: "ERC721" }, t("contracts.erc721"))
    ]);
    select.value = type;
    const table = dataTable([
        { label: "col.address", sort: (row) => row.label || row.address, search: (row) => row.label + " " + row.address, cell: (row) => contractLink(row.label, row.address, "#/contracts/" + row.address) },
        { label: "col.type", sort: (row) => row.type, cell: (row) => el("span", { class: "badge type" }, row.type) },
        { label: "col.txCount", sort: (row) => row.txCount || 0, cell: (row) => String(row.txCount) },
        { label: "col.created", sort: (row) => row.createdAt || 0, search: (row) => stamp(row.createdAt), cell: (row) => stamp(row.createdAt) },
        { label: "col.last", sort: (row) => row.lastAt || 0, search: (row) => ago(row.lastAt), cell: (row) => ago(row.lastAt) }
    ], data.items, { sort: 2, dir: "desc", page, key: "contracts" });
    show(el("section", { class: "card" }, [
        notice(status),
        el("div", { class: "card-head" }, [el("h2", {}, t("contracts.title")), select]),
        table
    ]));
}

// A contract: details, and its functions when the contract is in the registry
// (contracts/deployments). View/pure functions can be run (eth_call); state-changing functions are
// only listed: transactions are signed by the MPC signer through the proxy or the deploy tools.
// A small form helper: labelled inputs and a button that runs an action and shows its answer
function itemForm(title, note, fields, label, action, onDone) {
    const result = el("span", { class: "muted" });
    const button = el("button", { type: "button", class: "fn-run deploy-go" }, label);
    button.addEventListener("click", async () => {
        button.disabled = true;
        result.className = "muted";
        result.textContent = t("nick.signing");
        try {
            const r = await action();
            result.textContent = onDone ? onDone(r) : t("item.done");
            if (!onDone) {
                render();
            }
        } catch (error) {
            result.className = "bad-text";
            result.textContent = error.message;
        }
        button.disabled = false;
    });
    return el("div", { class: "deploy-form" }, [el("h3", {}, title), note ? el("div", { class: "muted" }, note) : null]
        .concat(fields.map(([key, input]) => el("label", {}, [el("span", { class: "muted" }, t(key)), input])))
        .concat([el("div", { class: "deploy-buttons" }, [button, result])]));
}

function itemInput(key, attrs) {
    return el("input", Object.assign({ class: "table-search", placeholder: t(key), "aria-label": t(key) }, attrs || {}));
}

// When a sold item can still be undone: "until <date>" or "—"
function undoCell(row, level) {
    const until = level ? row.levelUndoUntil : row.undoUntil;
    const can = level ? row.canUndoLevel : row.canUndo;
    return can && until ? t("item.until").replace("{date}", until.replace("T", " ").slice(0, 16)) : "—";
}

// A button that undoes a sale (or a nickname's newest level upgrade) after a confirmation
function undoButton(label, confirmText, path, body) {
    const b = el("button", { type: "button", class: "fn-run" }, label);
    b.addEventListener("click", async () => {
        if (!window.confirm(confirmText)) {
            return;
        }
        b.disabled = true;
        try {
            await deployPost(path, body || {});
            render();
        } catch (error) {
            window.alert(error.message);
            b.disabled = false;
        }
    });
    return b;
}

// Mint, price, sell and undo avatars of a collection (admin pages' gate), through the proxy's
// /admin/contract/send (mint, setPrice: the center) and /contract/send (buy: the buyer; undo: the
// consumption account that was paid)
async function avatarAdminCard(collection) {
    let status;
    try {
        status = await api("/api/avataradmin/status");
    } catch (error) {
        return null;
    }
    if (!status.enabled) {
        return null;
    }
    const tokenInput = el("input", { class: "table-search", type: "password", placeholder: t("sections.token"), "aria-label": t("sections.token"), autocomplete: "off", value: deployToken() });
    tokenInput.addEventListener("input", () => setDeployToken(tokenInput.value.trim()));
    const post = (action, body) => deployPost("/api/avataradmin/" + action, Object.assign({ collection }, body));

    const m = { image: itemInput("nft.image", { placeholder: "https://…/fox.png" }), price: itemInput("nft.price", { value: "0" }),
        description: itemInput("nft.description"), attributes: itemInput("nft.attributes", { placeholder: '[{"trait_type":"level","value":"1"}]' }) };
    const mint = itemForm(t("nft.mint"), null, [["nft.image", m.image], ["nft.price", m.price], ["nft.description", m.description], ["nft.attributes", m.attributes]],
        t("nft.mint"), () => {
            let attributes;
            if (m.attributes.value.trim()) {
                attributes = JSON.parse(m.attributes.value);
            }
            if (!m.image.value.trim()) {
                throw new Error(t("item.imageRequired"));
            }
            return post("mint", { image: m.image.value.trim(), price: m.price.value.trim() || "0", description: m.description.value.trim(), attributes });
        }, (r) => t("item.minted").replace("{id}", r.tokenId).replace("{price}", r.price));

    const p = { tokenId: itemInput("nft.tokenId", { placeholder: "1" }), price: itemInput("nft.price") };
    const price = itemForm(t("item.setPrice"), t("item.setPriceNote"), [["nft.tokenId", p.tokenId], ["nft.price", p.price]], t("nick.save"),
        () => post("price", { tokenId: p.tokenId.value.trim(), price: p.price.value.trim() }), (r) => t("item.priceSet").replace("{id}", r.tokenId).replace("{price}", r.price));

    const s = { token: itemInput("item.tokenOrImage", { placeholder: "1 or https://…/fox.png" }), buyer: itemInput("nft.buyer", { list: "avatar-buyers", placeholder: "0x…" }) };
    const buyers = el("datalist", { id: "avatar-buyers" });
    api("/api/accounts?limit=20000").then((d) => {
        buyers.replaceChildren(...d.items.filter((a) => a.role === "user").map((a) => el("option", { value: a.address }, a.section + " · " + a.balance + " ETH")));
    }).catch(() => {});
    const sell = itemForm(t("nft.sell"), t("nft.sellNote"), [["item.tokenOrImage", s.token], ["nft.buyer", s.buyer]], t("nft.sell"), () => {
        const v = s.token.value.trim();
        return post("sell", Object.assign({ to: s.buyer.value.trim() }, /^\d+$/.test(v) ? { tokenId: v } : { imageUrl: v }));
    }, (r) => t("item.sold").replace("{id}", r.tokenId).replace("{price}", r.paid).replace("{until}", String(r.undoUntil || "").replace("T", " ").slice(0, 16)));

    // the newest avatars with their state, and Undo while it is possible
    const list = el("div", {}, el("span", { class: "muted" }, "…"));
    deployToken() && sectionGet("/api/avataradmin/items?collection=" + collection).then((d) => {
        list.replaceChildren(dataTable([
            { label: "nft.tokenId", sort: (r) => Number(r.tokenId), cell: (r) => el("a", { href: "#/nfts/" + collection + "/" + r.tokenId }, "#" + r.tokenId) },
            { label: "nft.image", search: (r) => r.image, cell: (r) => el("span", { style: "word-break:break-all" }, r.image) },
            { label: "nft.price", sort: (r) => Number(r.price), cell: (r) => r.price + " ETH" },
            { label: "nft.owner", search: (r) => r.owner, cell: (r) => (r.sold ? el("a", { href: "#/accounts/" + r.owner }, short(r.owner)) : el("span", { class: "muted" }, t("item.forSale"))) },
            { label: "item.undo", cell: (r) => (r.canUndo ? el("span", {}, [undoCell(r, false) + " ", undoButton(t("item.undo"), t("item.confirmUndo").replace("{id}", r.tokenId), "/api/avataradmin/undo", { collection, tokenId: r.tokenId })]) : "—") }
        ], d.rows, { sort: 0, dir: "desc", key: "avatar-items" }));
    }).catch((error) => list.replaceChildren(el("span", { class: "bad-text" }, error.message)));

    return el("section", { class: "card stack" }, [
        el("h2", {}, t("nft.adminTitle")),
        el("div", { class: "muted", style: "margin-bottom:12px" }, t("nft.adminNote")),
        el("label", {}, [el("span", { class: "muted" }, t("sections.token")), tokenInput]),
        mint, price, sell, buyers,
        el("h3", {}, t("item.list")), list
    ]);
}

async function showContract(address) {
    const token = showToken;
    const data = await api("/api/contracts/" + address);

    if (token !== showToken) {
        return;
    }

    const kv = (label, value) => [el("span", { class: "muted" }, label), el("span", { style: "word-break:break-all" }, value == null || value === "" ? "—" : value)];
    const rec = data.record;
    const facts = el("div", { class: "kv" }, [
        ...kv(t("contract.address"), copyValue(data.address)),
        ...kv(t("col.type"), data.type),
        ...kv(t("contract.codeSize"), data.codeSize + " bytes"),
        ...(rec ? [
            ...kv(t("contract.deployer"), addr(rec.deployer)),
            ...kv(t("contract.deployTx"), rec.txHash ? ident(rec.txHash, "#/transactions/" + rec.txHash) : null),
            ...kv(t("tx.block"), rec.blockNumber != null ? el("a", { href: "#/blocks/" + rec.blockNumber }, "#" + rec.blockNumber) : null),
            ...kv(t("contract.deployedAt"), rec.deployedAt),
            ...kv(t("contract.artifact"), rec.artifact),
            ...kv(t("contract.args"), rec.constructorArgs && rec.constructorArgs.length ? JSON.stringify(rec.constructorArgs) : "—"),
            ...kv(t("contract.code"), data.codeMatchesRecord === false ? t("contract.codeChanged") : (rec.codeCheck || "—"))
        ] : [])
    ]);

    const parts = [
        el("div", { class: "muted", style: "margin-bottom:10px" }, [
            el("a", { href: "#/contracts" }, t("contracts.title")), " / ", data.address
        ]),
        el("section", { class: "card" }, [
            el("div", { class: "card-head" }, [
                el("h2", {}, [data.label && data.label !== data.address ? data.label : t("contract.details"), " ", data.registered ? el("span", { class: "badge abi" }, "ABI") : null]),
                el("a", { href: "#/transactions?address=" + data.address }, t("contract.txs") + " (" + data.txCount + ")")
            ]),
            facts
        ])
    ];

    if (data.avatar) {
        const nftCard = await avatarAdminCard(data.address);
        if (token !== showToken) {
            return;
        }
        if (nftCard) {
            parts.push(nftCard);
        }
    }

    if (!data.registered) {
        parts.push(el("section", { class: "card stack" }, [
            el("h2", {}, t("contract.read")),
            el("div", { class: "empty" }, t("contract.noAbi")),
            data.registryError ? el("div", { class: "muted" }, data.registryError) : null
        ]));
        return show(el("div", {}, parts));
    }

    const readList = el("div", { class: "fn-list" });
    if (!data.read.length) {
        readList.append(el("div", { class: "empty" }, t("contract.noRead")));
    }
    for (const fn of data.read) {
        const inputs = fn.inputs.map((p, i) => el("input", {
            class: "table-search fn-arg",
            placeholder: (p.name || "arg" + i) + " (" + p.type + ")",
            "aria-label": (p.name || "arg" + i) + " " + p.type
        }));
        const result = el("div", { class: "fn-result" });
        const run = async () => {
            result.replaceChildren(el("span", { class: "muted" }, "…"));
            try {
                const response = await fetch("/api/contracts/" + data.address + "/call", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ signature: fn.signature, args: inputs.map((input) => input.value) })
                });
                const body = await response.json();
                if (!response.ok) {
                    throw new Error(body.error || "call failed");
                }
                result.replaceChildren(...body.outputs.map((o) => el("div", { class: "fn-out" }, [
                    el("span", { class: "muted" }, (o.name && !/^\d+$/.test(o.name) ? o.name + " " : "") + o.type + ": "),
                    /^0x[0-9a-fA-F]{40}$/.test(String(o.value)) ? addr(o.value) : el("code", { style: "word-break:break-all" }, typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value))
                ])), el("div", { class: "muted fn-at" }, t("contract.atBlock") + " #" + body.block));
            } catch (error) {
                result.replaceChildren(el("span", { class: "bad-text" }, error.message));
            }
        };
        for (const input of inputs) {
            input.addEventListener("keydown", (event) => { if (event.key === "Enter") run(); });
        }
        readList.append(el("div", { class: "fn" }, [
            el("div", { class: "fn-head" }, [
                el("b", {}, fn.name),
                el("span", { class: "muted" }, "(" + fn.inputs.map((p) => p.type + (p.name ? " " + p.name : "")).join(", ") + ")" + (fn.outputs.length ? " → " + fn.outputs.map((p) => p.type).join(", ") : ""))
            ]),
            inputs.length ? el("div", { class: "fn-args" }, inputs) : null,
            el("div", {}, [el("button", { type: "button", class: "fn-run", onclick: run }, t("contract.query"))]),
            result
        ]));
    }

    parts.push(el("section", { class: "card stack" }, [el("h2", {}, t("contract.read")), readList]));
    parts.push(el("section", { class: "card stack" }, [
        el("h2", {}, t("contract.write")),
        el("div", { class: "muted", style: "margin-bottom:8px" }, t("contract.writeNote")),
        data.write.length
            ? el("ul", { class: "fn-sigs" }, data.write.map((fn) => el("li", {}, [el("code", {}, fn.signature), fn.stateMutability === "payable" ? " payable" : ""])))
            : el("div", { class: "empty" }, "—"),
        data.events.length ? el("h3", {}, t("tx.events")) : null,
        data.events.length ? el("ul", { class: "fn-sigs" }, data.events.map((e) => el("li", {}, el("code", {}, e)))) : null
    ]));
    show(el("div", {}, parts));
}

// ---- Deploy page: only shown to the operator's address when the server has it on
// (chainlens_deploy_enabled). The token stays in this browser tab (sessionStorage).
const deployState = { file: null, name: "", artifact: null, contracts: [], contract: "", args: {}, label: "", kind: "common", plan: null, result: null, error: "" };

function deployToken() {
    try {
        return sessionStorage.getItem("chainlens.deployToken") || "";
    } catch (error) {
        return deployState.token || "";
    }
}

function setDeployToken(value) {
    deployState.token = value;
    try {
        sessionStorage.setItem("chainlens.deployToken", value);
    } catch (error) {
        // memory only
    }
}

async function deployPost(path, body) {
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + deployToken() },
        body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || ("HTTP " + response.status));
    }
    return data;
}

function deployBody(extra) {
    const c = deployState.contracts.find((x) => x.name === deployState.contract);
    return {
        artifact: deployState.artifact,
        artifactName: deployState.file,
        contract: deployState.contract,
        name: deployState.label,
        kind: deployState.kind,
        args: c ? c.inputs.map((p, i) => deployState.args[i] || "") : [],
        ...extra
    };
}

async function showDeploy() {
    const token = showToken;
    const status = await api("/api/deploy/status");

    if (token !== showToken) {
        return;
    }
    if (!status.enabled) {
        return show(el("section", { class: "card" }, [el("h2", {}, t("deploy.title")), el("div", { class: "empty" }, t("deploy.off"))]));
    }

    const planBox = el("div");
    const resultBox = el("div");
    const errorBox = el("div", { class: "bad-text deploy-error" });
    const argsBox = el("div", { class: "fn-args" });
    const contractSelect = el("select", { class: "deploy-contract" });
    const contractRow = el("label", {}, [el("span", { class: "muted" }, t("deploy.contract")), contractSelect]);
    const checkButton = el("button", { type: "button", class: "fn-run" }, t("deploy.check"));
    const deployButton = el("button", { type: "button", class: "fn-run deploy-go" }, t("deploy.deploy"));

    const invalidate = () => {
        deployState.plan = null;
        deployState.result = null;
        paint();
    };

    function paintArgs() {
        argsBox.replaceChildren();
        const c = deployState.contracts.find((x) => x.name === deployState.contract);
        if (!c) {
            return;
        }
        if (!c.inputs.length) {
            argsBox.append(el("div", { class: "muted" }, t("deploy.noArgs")));
        }
        c.inputs.forEach((p, i) => {
            const input = el("input", {
                class: "table-search fn-arg",
                placeholder: (p.name || "arg" + i) + " (" + p.type + ")",
                "aria-label": (p.name || "arg" + i) + " " + p.type,
                value: deployState.args[i] || ""
            });
            input.addEventListener("input", () => { deployState.args[i] = input.value; invalidate(); });
            argsBox.append(input);
        });
    }

    function paint() {
        errorBox.textContent = deployState.error || "";
        contractSelect.replaceChildren(...deployState.contracts.map((c) => el("option", { value: c.name }, c.name + " (" + c.size + " bytes)")));
        contractSelect.value = deployState.contract;
        contractRow.hidden = deployState.contracts.length < 2;
        checkButton.disabled = !deployState.artifact || !deployState.contract;
        deployButton.disabled = !deployState.plan;
        planBox.replaceChildren();
        const plan = deployState.plan;
        if (plan) {
            const kv = (label, value) => [el("span", { class: "muted" }, label), el("span", { style: "word-break:break-all" }, value)];
            planBox.append(el("div", { class: "kv deploy-plan" }, [
                ...kv(t("deploy.contract"), plan.name + " (" + plan.creationSize + " bytes)"),
                ...kv(t("contract.args"), plan.args.length ? JSON.stringify(plan.args) : "—"),
                ...kv(t("deploy.kind"), plan.kind === "avatar" || plan.kind === "nft" ? t("deploy.kindAvatar") : t("deploy.kindCommon")),
                ...kv(t("contract.deployer"), plan.from),
                ...kv(t("deploy.gas"), plan.gas + " (estimate " + plan.estimate + ")"),
                ...kv(t("deploy.address"), plan.address)
            ]), el("div", { class: "muted", style: "margin-top:8px" }, t("deploy.ready")));
        }
        resultBox.replaceChildren();
        const r = deployState.result;
        if (r) {
            resultBox.append(el("div", { class: "deploy-done" }, [
                el("h3", {}, t("deploy.done")),
                el("div", { class: "kv" }, [
                    el("span", { class: "muted" }, t("deploy.address")), el("a", { href: "#/contracts/" + r.address }, r.address),
                    el("span", { class: "muted" }, t("contract.deployTx")), ident(r.txHash, "#/transactions/" + r.txHash),
                    el("span", { class: "muted" }, t("tx.block")), el("a", { href: "#/blocks/" + r.blockNumber }, "#" + r.blockNumber),
                    el("span", { class: "muted" }, t("contract.code")), el("span", {}, r.codeCheck)
                ]),
                el("div", { class: "muted", style: "margin-top:8px" }, r.saved ? t("deploy.saved") : t("deploy.notSaved"))
            ]));
        }
    }

    const tokenInput = el("input", { class: "table-search", type: "password", placeholder: t("deploy.token"), "aria-label": t("deploy.token"), autocomplete: "off", value: deployToken() });
    tokenInput.addEventListener("input", () => setDeployToken(tokenInput.value.trim()));

    const fileInput = el("input", { type: "file", accept: ".json,application/json", class: "deploy-file" });
    fileInput.addEventListener("change", async () => {
        const file = fileInput.files && fileInput.files[0];
        Object.assign(deployState, { file: null, artifact: null, contracts: [], contract: "", args: {}, label: "", plan: null, result: null, error: "" });
        if (!file) {
            paintArgs();
            return paint();
        }
        try {
            const artifact = JSON.parse(await file.text());
            deployState.file = file.name;
            deployState.artifact = artifact;
            const info = await deployPost("/api/deploy/inspect", { artifact, artifactName: file.name });
            deployState.contracts = info.contracts;
            deployState.contract = info.contracts[0].name;
        } catch (error) {
            deployState.error = error instanceof SyntaxError ? t("deploy.notJson") : error.message;
        }
        paintArgs();
        paint();
    });

    contractSelect.addEventListener("change", () => {
        deployState.contract = contractSelect.value;
        deployState.args = {};
        paintArgs();
        invalidate();
    });

    const kindSelect = el("select", { class: "deploy-contract", "aria-label": t("deploy.kind") }, [
        el("option", { value: "common" }, t("deploy.kindCommon")),
        el("option", { value: "avatar" }, t("deploy.kindAvatar"))
    ]);
    kindSelect.value = deployState.kind;
    kindSelect.addEventListener("change", () => { deployState.kind = kindSelect.value; invalidate(); });
    const labelInput = el("input", { class: "table-search", placeholder: t("deploy.name"), "aria-label": t("deploy.name"), value: deployState.label });
    labelInput.addEventListener("input", () => { deployState.label = labelInput.value; invalidate(); });

    checkButton.addEventListener("click", async () => {
        deployState.error = "";
        deployState.plan = null;
        deployState.result = null;
        checkButton.disabled = true;
        errorBox.textContent = "…";
        try {
            deployState.plan = await deployPost("/api/deploy/check", deployBody());
        } catch (error) {
            deployState.error = error.message;
        }
        paint();
    });

    deployButton.addEventListener("click", async () => {
        const plan = deployState.plan;
        if (!plan || !window.confirm(t("deploy.confirm").replace("{name}", plan.name).replace("{address}", plan.address))) {
            return;
        }
        deployState.error = "";
        checkButton.disabled = true;
        deployButton.disabled = true;
        errorBox.replaceChildren(el("span", { class: "muted" }, t("deploy.signing")));
        try {
            deployState.result = await deployPost("/api/deploy/send", deployBody({ expectAddress: plan.address }));
            deployState.plan = null;
        } catch (error) {
            deployState.error = error.message;
            deployState.plan = null;
        }
        paint();
    });

    paintArgs();
    paint();
    show(el("div", {}, [
        el("section", { class: "card" }, [
            el("h2", {}, t("deploy.title")),
            el("div", { class: "muted", style: "margin-bottom:12px" }, t("deploy.intro").replace("{deployer}", status.deployer)),
            el("div", { class: "deploy-form" }, [
                el("label", {}, [el("span", { class: "muted" }, t("deploy.token")), tokenInput]),
                el("label", {}, [el("span", { class: "muted" }, t("deploy.artifact")), fileInput]),
                contractRow,
                el("div", {}, [el("span", { class: "muted" }, t("contract.args")), argsBox]),
                el("label", {}, [el("span", { class: "muted" }, t("deploy.kind")), kindSelect]),
                el("label", {}, [el("span", { class: "muted" }, t("deploy.name")), labelInput]),
                el("div", { class: "deploy-buttons" }, [checkButton, deployButton])
            ]),
            errorBox,
            planBox,
            resultBox
        ])
    ]));
}

// ---- Sections pages (docs/features/sections.md): only shown to the operator's and chainlens_deploy_ips'
// browsers when the server has them on (chainlens_sections_enabled). Uses the admin token of the
// Deploy page (same token, kept in this tab).
async function sectionGet(path) {
    const response = await fetch(path, { headers: { authorization: "Bearer " + deployToken() } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || ("HTTP " + response.status));
        error.status = response.status;
        throw error;
    }
    return data;
}

function tokenBox(onSaved) {
    const input = el("input", { class: "table-search", type: "password", placeholder: t("sections.token"), "aria-label": t("sections.token"), autocomplete: "off", value: deployToken() });
    const save = el("button", { type: "button", class: "fn-run" }, t("sections.useToken"));
    save.addEventListener("click", () => { setDeployToken(input.value.trim()); onSaved(); });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") save.click(); });
    return el("div", { class: "deploy-form" }, [
        el("label", {}, [el("span", { class: "muted" }, t("sections.token")), input]),
        el("div", { class: "deploy-buttons" }, [save])
    ]);
}

function keyBox(name, key) {
    return el("div", { class: "key-box" }, [
        el("b", {}, t("sections.keyFor").replace("{name}", name)),
        el("div", { class: "muted" }, t("sections.keyOnce")),
        el("div", { class: "key-value" }, [el("code", {}, key), copyButton(key)])
    ]);
}

function infoText(info) {
    return Object.entries(info || {}).map(([k, v]) => k + ": " + v).join(" · ");
}

async function showSections() {
    const token = showToken;
    const status = await api("/api/sections/status");
    if (token !== showToken) {
        return;
    }
    if (!status.enabled) {
        return show(el("section", { class: "card" }, [el("h2", {}, t("sections.title")), el("div", { class: "empty" }, t("sections.off"))]));
    }

    const message = el("div", { class: "deploy-error" });
    let data;
    try {
        data = deployToken() ? await sectionGet("/api/sections") : null;
    } catch (error) {
        if (error.status === 401) {
            setDeployToken("");
        }
        message.textContent = error.message;
    }
    if (token !== showToken) {
        return;
    }
    if (!data) {
        return show(el("section", { class: "card" }, [el("h2", {}, t("sections.title")), el("div", { class: "muted", style: "margin-bottom:12px" }, t("sections.needToken")), tokenBox(() => render()), message]));
    }

    // create
    const nameInput = el("input", { class: "table-search", placeholder: t("sections.name"), "aria-label": t("sections.name") });
    const descInput = el("input", { class: "table-search", placeholder: t("sections.description"), "aria-label": t("sections.description") });
    const createButton = el("button", { type: "button", class: "fn-run deploy-go" }, t("sections.create"));
    const createResult = el("div");
    createButton.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        if (!name || !window.confirm(t("sections.confirmCreate").replace("{name}", name))) {
            return;
        }
        createButton.disabled = true;
        createResult.replaceChildren(el("span", { class: "muted" }, t("sections.creating")));
        try {
            const info = descInput.value.trim() ? { description: descInput.value.trim() } : {};
            const r = await deployPost("/api/sections", { name, info });
            createResult.replaceChildren(keyBox(r.section.name, r.apiKey), el("div", { style: "margin-top:8px" }, el("a", { href: "#/sections/" + r.section.id }, t("sections.open").replace("{name}", r.section.name))));
            nameInput.value = "";
            descInput.value = "";
        } catch (error) {
            createResult.replaceChildren(el("span", { class: "bad-text" }, error.message));
        }
        createButton.disabled = false;
    });

    const table = dataTable([
        { label: "col.id", sort: (row) => row.id, cell: (row) => String(row.id) },
        { label: "sections.name", sort: (row) => row.name, search: (row) => row.name, cell: (row) => el("a", { href: "#/sections/" + row.id }, row.name) },
        { label: "sections.status", sort: (row) => (row.active ? 1 : 0), cell: (row) => el("span", { class: "badge " + (row.active ? "type" : "create") }, row.active ? t("sections.active") : t("sections.disabled")) },
        { label: "sections.upfront", sort: (row) => Number(row.balances.upfront), cell: (row) => row.balances.upfront },
        { label: "sections.consumption", sort: (row) => Number(row.balances.consumption), cell: (row) => row.balances.consumption },
        { label: "sections.payment", sort: (row) => Number(row.balances.payment), cell: (row) => row.balances.payment },
        { label: "sections.info", sort: (row) => infoText(row.info), search: (row) => infoText(row.info), cell: (row) => infoText(row.info) }
    ], data.sections, { sort: 0, dir: "asc", key: "sections" });

    // a section whose gateway is offline (or draining): admin writes on it must wait
    const gatewayNotice = el("div");
    sectionGet("/api/sections/gateways").then((g) => {
        const name = (id) => ((data.sections.find((s) => s.id === id) || {}).name || "#" + id);
        gatewayNotice.replaceChildren(...g.gateways.filter((x) => x.mode !== "online").map((x) => el("div", { class: "card bad-text", style: "margin-bottom:12px" },
            (x.mode === "unreachable" ? t("gateway.unreachable") : t("gateway.offline")).replace("{section}", name(x.section)).replace("{mode}", x.mode)
                .replace("{queue}", x.queue || 0).replace("{since}", String(x.since || "").replace("T", " ").slice(0, 16)))),
        ...g.gateways.filter((x) => x.corrections && x.corrections.open > 0).map((x) => el("div", { class: "card", style: "margin-bottom:12px" },
            el("a", { href: "#/sections/" + x.section }, t("gateway.openNotice").replace("{section}", name(x.section)).replace("{n}", x.corrections.open)))));
    }).catch(() => {});

    show(el("div", {}, [
        gatewayNotice,
        el("section", { class: "card" }, [
            el("div", { class: "card-head" }, [el("h2", {}, t("sections.title")), el("span", { class: "muted" }, t("sections.registry") + " " + short(data.registry))]),
            data.sections.length ? table : el("div", { class: "empty" }, t("sections.none"))
        ]),
        el("section", { class: "card stack" }, [
            el("h2", {}, t("sections.new")),
            el("div", { class: "muted", style: "margin-bottom:12px" }, t("sections.newNote")),
            el("div", { class: "deploy-form" }, [
                el("label", {}, [el("span", { class: "muted" }, t("sections.name")), nameInput]),
                el("label", {}, [el("span", { class: "muted" }, t("sections.description")), descInput]),
                el("div", { class: "deploy-buttons" }, [createButton])
            ]),
            createResult
        ]),
        message
    ]));
}

async function showSection(id) {
    const token = showToken;
    const status = await api("/api/sections/status");
    if (token !== showToken) {
        return;
    }
    if (!status.enabled) {
        return show(el("section", { class: "card" }, [el("h2", {}, t("sections.title")), el("div", { class: "empty" }, t("sections.off"))]));
    }
    let data;
    try {
        data = await sectionGet("/api/sections/" + id + "/history");
    } catch (error) {
        if (error.status === 401) {
            setDeployToken("");
            return show(el("section", { class: "card" }, [el("h2", {}, t("sections.title")), el("div", { class: "muted", style: "margin-bottom:12px" }, t("sections.needToken")), tokenBox(() => render()), el("div", { class: "bad-text" }, error.message)]));
        }
        throw error;
    }
    if (token !== showToken) {
        return;
    }
    const s = data.section;
    const result = el("div", { class: "deploy-error" });
    if (s.archived) {
        return show(el("div", {}, [
            el("div", { class: "muted", style: "margin-bottom:10px" }, [el("a", { href: "#/sections" }, t("sections.title")), " / ", s.name]),
            el("section", { class: "card" }, [el("h2", {}, s.name + " (" + t("sections.archivedBadge") + ")"), el("div", { class: "muted" }, t("sections.archivedNote"))])
        ]));
    }
    const done = (r, text) => {
        result.replaceChildren(el("span", {}, text), r.txHash ? el("span", {}, [" ", ident(r.txHash, "#/transactions/" + r.txHash)]) : null,
            el("span", { class: "muted" }, " " + t("sections.refreshSoon")));
        setTimeout(() => { if (location.hash === "#/sections/" + id) render(); }, 4000);
    };
    const act = async (button, action, body, confirmText, onDone) => {
        if (confirmText && !window.confirm(confirmText)) {
            return;
        }
        button.disabled = true;
        result.replaceChildren(el("span", { class: "muted" }, "…"));
        try {
            const r = await deployPost("/api/sections/" + id + "/" + action, body);
            onDone(r);
        } catch (error) {
            result.replaceChildren(el("span", { class: "bad-text" }, error.message));
        }
        button.disabled = false;
    };
    const moveRow = (label, action, allowAll, from, to) => {
        const input = el("input", { class: "table-search", placeholder: allowAll ? t("sections.amountOrAll") : t("sections.amount"), "aria-label": label });
        const button = el("button", { type: "button", class: "fn-run" }, label);
        button.addEventListener("click", () => {
            const amount = input.value.trim();
            if (!amount) {
                return;
            }
            act(button, action, { amount }, t("sections.confirmMove").replace("{op}", label).replace("{amount}", amount).replace("{from}", from).replace("{to}", to),
                (r) => { input.value = ""; done(r, label + ": " + r.amount + " ETH"); });
        });
        return el("div", { class: "section-action" }, [el("span", { class: "muted" }, label + " (" + from + " → " + to + ")"), el("div", { class: "section-inputs" }, [input, button])]);
    };

    const nameInput = el("input", { class: "table-search", value: s.name, "aria-label": t("sections.name") });
    const nameButton = el("button", { type: "button", class: "fn-run" }, t("sections.rename"));
    nameButton.addEventListener("click", () => act(nameButton, "name", { name: nameInput.value.trim() }, null, (r) => done(r, t("sections.renamed").replace("{name}", r.name))));

    // info fields: one row each (edit / remove), plus a row to add one
    const infoRows = el("div", { class: "section-actions" });
    const infoRow = (key, value, isNew) => {
        const keyInput = el("input", { class: "table-search info-key", value: key, placeholder: t("sections.infoKey"), "aria-label": t("sections.infoKey") });
        if (!isNew) {
            keyInput.readOnly = true;
        }
        const valueInput = el("input", { class: "table-search", value, placeholder: t("sections.infoValue"), "aria-label": t("sections.infoValue") });
        const save = el("button", { type: "button", class: "fn-run" }, isNew ? t("sections.add") : t("sections.save"));
        save.addEventListener("click", () => act(save, "info", { key: keyInput.value.trim(), value: valueInput.value }, null, (r) => done(r, t("sections.infoSaved").replace("{key}", r.key))));
        const parts = [keyInput, valueInput, save];
        if (!isNew) {
            const remove = el("button", { type: "button", class: "fn-run" }, t("sections.remove"));
            remove.addEventListener("click", () => act(remove, "info", { key, value: "" }, t("sections.confirmRemoveInfo").replace("{key}", key), (r) => done(r, t("sections.infoRemoved").replace("{key}", r.key))));
            parts.push(remove);
        }
        return el("div", { class: "section-inputs" }, parts);
    };
    for (const [k, v] of Object.entries(s.info || {})) {
        infoRows.append(infoRow(k, v, false));
    }
    infoRows.append(infoRow("", "", true));

    const replaceButtons = ["upfront", "consumption", "payment"].map((role) => {
        const b = el("button", { type: "button", class: "fn-run" }, t("sections.replace").replace("{role}", t("sections." + role)));
        b.addEventListener("click", () => act(b, "account", { role }, t("sections.confirmReplace").replace("{role}", t("sections." + role)).replace("{name}", s.name),
            (r) => done(r, t("sections.replaced").replace("{role}", t("sections." + role)).replace("{account}", r.account))));
        return b;
    });

    const archiveButton = el("button", { type: "button", class: "fn-run danger" }, t("sections.archive"));
    archiveButton.addEventListener("click", () => {
        const typed = window.prompt(t("sections.confirmArchive").replace(/\{name\}/g, s.name));
        if (typed === null) {
            return;
        }
        act(archiveButton, "archive", { confirm: typed }, null, () => {
            result.replaceChildren(el("span", {}, t("sections.archived").replace("{name}", s.name)));
            setTimeout(() => { location.hash = "#/sections"; }, 2500);
        });
    });
    const keyButton = el("button", { type: "button", class: "fn-run" }, t("sections.rotate"));
    keyButton.addEventListener("click", () => act(keyButton, "key", {}, t("sections.confirmRotate").replace("{name}", s.name), (r) => result.replaceChildren(keyBox(s.name, r.apiKey))));
    const activeButton = el("button", { type: "button", class: "fn-run" }, s.active ? t("sections.disable") : t("sections.enable"));
    activeButton.addEventListener("click", () => act(activeButton, "active", { active: !s.active },
        (s.active ? t("sections.confirmDisable") : t("sections.confirmEnable")).replace("{name}", s.name), (r) => done(r, r.active ? t("sections.active") : t("sections.disabled"))));

    // user accounts of the section: list (loaded after the page), create, +x / -x
    const accountsBox = el("div", {}, el("span", { class: "muted" }, "…"));
    const transferAccount = el("select", { class: "deploy-contract", "aria-label": t("sections.account") });
    const loadAccounts = async () => {
        try {
            const r = await sectionGet("/api/sections/" + id + "/accounts");
            transferAccount.replaceChildren(...r.accounts.map((a) => el("option", { value: a.address }, short(a.address) + " (" + a.balance + " ETH)")));
            accountsBox.replaceChildren(r.accounts.length ? dataTable([
                { label: "col.address", sort: (row) => row.address, search: (row) => row.address, cell: (row) => addr(row.address) },
                { label: "account.balance", sort: (row) => Number(row.balance), cell: (row) => row.balance + " ETH" },
                { label: "sections.addedIn", sort: (row) => row.addedIn, cell: (row) => el("a", { href: "#/blocks/" + row.addedIn }, "#" + row.addedIn) }
            ], r.accounts, { sort: 2, dir: "desc", key: "section-accounts" }) : el("div", { class: "empty" }, t("sections.noAccounts")));
        } catch (error) {
            accountsBox.replaceChildren(el("span", { class: "bad-text" }, error.message));
        }
    };
    loadAccounts();
    const newAmount = el("input", { class: "table-search", placeholder: t("sections.amount"), "aria-label": t("sections.amount"), value: "0" });
    const newPool = el("select", { class: "deploy-contract", "aria-label": t("sections.pool") }, ["small", "big", "none"].map((v) => el("option", { value: v }, v)));
    const newButton = el("button", { type: "button", class: "fn-run" }, t("sections.createAccount"));
    newButton.addEventListener("click", () => act(newButton, "accounts", { amount: newAmount.value.trim() || "0", pool: newPool.value },
        t("sections.confirmCreateAccount").replace("{amount}", newAmount.value.trim() || "0").replace("{name}", s.name),
        (r) => { done(r, t("sections.accountCreated").replace("{address}", r.address)); loadAccounts(); }));
    const moveAmount = el("input", { class: "table-search", placeholder: t("sections.signedAmount"), "aria-label": t("sections.signedAmount") });
    const moveButton = el("button", { type: "button", class: "fn-run" }, t("sections.transfer"));
    moveButton.addEventListener("click", () => {
        const amount = moveAmount.value.trim();
        if (!amount || !transferAccount.value) {
            return;
        }
        const text = amount.startsWith("-")
            ? t("sections.confirmOut").replace("{amount}", amount.slice(1)).replace("{account}", short(transferAccount.value))
            : t("sections.confirmIn").replace("{amount}", amount).replace("{account}", short(transferAccount.value));
        act(moveButton, "transfer", { account: transferAccount.value, amount }, text, (r) => { moveAmount.value = ""; done(r, r.direction + ": " + r.amount + " ETH"); loadAccounts(); });
    });

    const accountRow = (role, label) => [el("span", { class: "muted" }, label), el("span", {}, [addr(s.accounts[role]), "  ", el("b", {}, s.balances[role] + " ETH")])];
    const gatewayBox = el("div");
    const history = dataTable([
        { label: "col.time", sort: (row) => row.timestamp || 0, cell: (row) => stamp(row.timestamp) },
        { label: "sections.kind", sort: (row) => row.kind, search: (row) => row.kind + " " + (row.memo || ""), cell: (row) => el("span", { class: "badge type" }, row.kind) },
        { label: "col.value", sort: (row) => Number(row.value), cell: (row) => row.value },
        { label: "col.from", sort: (row) => row.from, cell: (row) => addr(row.from) },
        { label: "col.to", sort: (row) => row.to || "", cell: (row) => (row.to ? addr(row.to) : el("span", {}, "—")) },
        { label: "sections.memo", sort: (row) => row.memo || "", cell: (row) => row.memo || "" },
        { label: "col.hash", sort: (row) => row.hash, cell: (row) => ident(row.hash, "#/transactions/" + row.hash) }
    ], data.history, { sort: 0, dir: "desc", key: "section-history" });

    show(el("div", {}, [
        el("div", { class: "muted", style: "margin-bottom:10px" }, [el("a", { href: "#/sections" }, t("sections.title")), " / ", s.name]),
        el("section", { class: "card" }, [
            el("div", { class: "card-head" }, [
                el("h2", {}, [s.name + " ", el("span", { class: "badge " + (s.active ? "type" : "create") }, s.active ? t("sections.active") : t("sections.disabled"))]),
                el("span", { class: "muted" }, "#" + s.id)
            ]),
            el("div", { class: "kv" }, [
                ...accountRow("upfront", t("sections.upfront")),
                ...accountRow("consumption", t("sections.consumption")),
                ...accountRow("payment", t("sections.payment")),
                ...Object.entries(s.info || {}).flatMap(([k, v]) => [el("span", { class: "muted" }, k), el("span", { style: "word-break:break-word" }, v)]),
                el("span", { class: "muted" }, t("sections.created")), el("span", {}, stamp(s.createdAt))
            ])
        ]),
        el("section", { class: "card stack" }, [
            el("h2", {}, t("sections.money")),
            el("div", { class: "section-actions" }, [
                moveRow(t("sections.topup"), "topup", false, "SENDER01", t("sections.upfront")),
                moveRow(t("sections.sweep"), "sweep", true, t("sections.consumption"), t("sections.payment")),
                moveRow(t("sections.payback"), "payback", true, t("sections.payment"), "SENDER01")
            ]),
            result
        ]),
        el("section", { class: "card stack" }, [
            el("h2", {}, t("sections.accounts")),
            el("div", { class: "muted", style: "margin-bottom:10px" }, t("sections.accountsNote")),
            accountsBox,
            el("div", { class: "section-actions", style: "margin-top:12px" }, [
                el("div", { class: "section-action" }, [el("span", { class: "muted" }, t("sections.newAccount")), el("div", { class: "section-inputs" }, [newAmount, newPool, newButton])]),
                el("div", { class: "section-action" }, [el("span", { class: "muted" }, t("sections.transferLabel")), el("div", { class: "section-inputs" }, [transferAccount, moveAmount, moveButton])])
            ])
        ]),
        el("section", { class: "card stack" }, [
            el("h2", {}, t("sections.settings")),
            el("div", { class: "section-actions" }, [
                el("div", { class: "section-action" }, [el("span", { class: "muted" }, t("sections.name")), el("div", { class: "section-inputs" }, [nameInput, nameButton])]),
                el("div", { class: "section-action" }, [el("span", { class: "muted" }, t("sections.infoFields")), infoRows]),
                el("div", { class: "section-action" }, [el("span", { class: "muted" }, t("sections.keyLabel")), el("div", { class: "section-inputs" }, [keyButton, activeButton])]),
                el("div", { class: "section-action" }, [el("span", { class: "muted" }, t("sections.accountsLabel")), el("div", { class: "section-inputs" }, replaceButtons)]),
                el("div", { class: "section-action" }, [el("span", { class: "muted" }, t("sections.archiveLabel")), el("div", { class: "section-inputs" }, [archiveButton])])
            ])
        ]),
        gatewayBox,
        el("section", { class: "card stack" }, [
            el("h2", {}, t("sections.history")),
            data.history.length ? history : el("div", { class: "empty" }, t("sections.noHistory"))
        ])
    ]));
    gatewayCard(id).then((card) => gatewayBox.replaceChildren(card || "")).catch((error) => gatewayBox.replaceChildren(
        el("section", { class: "card" }, [el("h2", {}, t("gateway.title")), el("div", { class: "bad-text" }, error.message)])));
}

// The section's gateway (docs/components/gateway.md): its mode, the corrections (queued requests the chain
// refused after a cut) with an Acknowledge button, and the reconcile reports. null: the section has no gateway.
async function gatewayCard(id) {
    let g;
    try {
        g = await sectionGet("/api/sections/" + id + "/gateway");
    } catch (error) {
        if (error.status === 404) {
            return null;
        }
        throw error;
    }
    const s = g.status;
    const c = s.corrections || {};
    const when = (x) => String(x || "").replace("T", " ").slice(0, 19);
    const corrections = g.reports.filter((r) => r.kind === "conflict");
    const reconciles = g.reports.filter((r) => r.kind === "reconcile");
    const openOnly = el("input", { type: "checkbox", "aria-label": t("gateway.openOnly") });
    openOnly.checked = corrections.some((r) => !r.acked);
    const list = el("div");
    const ackButton = (r) => {
        const b = el("button", { type: "button", class: "fn-run" }, t("gateway.ack"));
        b.addEventListener("click", async () => {
            b.disabled = true;
            try {
                await deployPost("/api/sections/" + id + "/gateway/ack/" + r.id, {});
                render();
            } catch (error) {
                b.replaceWith(el("span", { class: "bad-text" }, error.message));
            }
        });
        return b;
    };
    const what = (r) => {
        const b = r.body || {};
        const fn = r.path === "/contract/send" ? (b.function || "") + " " + JSON.stringify(b.args || {}) : r.path + " " + (b.amount || "");
        return el("span", { style: "word-break:break-word" }, fn);
    };
    const drawList = () => {
        const rows = corrections.filter((r) => !openOnly.checked || !r.acked);
        list.replaceChildren(rows.length ? dataTable([
            { label: "col.time", sort: (r) => r.at, cell: (r) => when(r.at) },
            { label: "gateway.kind", sort: (r) => r.correction || "", search: (r) => r.correction + " " + (r.reason || ""), cell: (r) => el("span", { class: "badge create" }, r.correction || "other") },
            { label: "gateway.request", sort: (r) => r.path || "", cell: what },
            { label: "gateway.account", sort: (r) => (r.body || {}).from || (r.body || {}).account || "", cell: (r) => {
                const a = (r.body || {}).from || (r.body || {}).account;
                return a ? addr(a) : el("span", {}, "—");
            } },
            { label: "gateway.refund", sort: (r) => Number(r.refundEth || 0), cell: (r) => r.refundEth || "0" },
            { label: "gateway.reason", sort: (r) => r.reason || "", cell: (r) => el("span", { style: "word-break:break-word" }, [r.reason || "",
                (r.cancelled || []).length ? el("div", { class: "muted" }, t("gateway.cancelled").replace("{n}", r.cancelled.length)) : null]) },
            { label: "gateway.acked", sort: (r) => (r.acked ? 1 : 0), cell: (r) => (r.acked ? el("span", { class: "muted" }, when(r.acked.at)) : ackButton(r)) }
        ], rows, { sort: 0, dir: "desc", key: "gateway-corrections" }) : el("div", { class: "empty" }, t("gateway.noCorrections")));
    };
    openOnly.addEventListener("change", drawList);
    drawList();
    const modeClass = s.mode === "online" ? "type" : "create";
    return el("section", { class: "card stack" }, [
        el("div", { class: "card-head" }, [
            el("h2", {}, [t("gateway.title") + " ", el("span", { class: "badge " + modeClass }, s.mode)]),
            el("span", { class: "muted" }, g.url)
        ]),
        el("div", { class: "muted", style: "margin-bottom:10px" }, t("gateway.note")),
        el("div", { class: "kv" }, [
            el("span", { class: "muted" }, t("gateway.since")), el("span", {}, s.since ? when(s.since) : "—"),
            el("span", { class: "muted" }, t("gateway.queue")), el("span", {}, String(s.queue) + (s.oldestSeconds ? " (" + s.oldestSeconds + " s)" : "")),
            el("span", { class: "muted" }, t("gateway.spares")), el("span", {}, s.spares + " / " + s.limits.spareAccounts),
            el("span", { class: "muted" }, t("gateway.cuts")), el("span", {}, String(s.cuts || 0)),
            el("span", { class: "muted" }, t("gateway.corrections")), el("span", {}, t("gateway.correctionsValue").replace("{open}", c.open || 0).replace("{total}", c.total || 0).replace("{eth}", c.refundedEth || "0")),
            el("span", { class: "muted" }, t("gateway.lastSync")), el("span", {}, when(s.lastSync) || "—"),
            el("span", { class: "muted" }, t("gateway.lastBackup")), el("span", {}, when(s.lastBackup) || "—")
        ]),
        el("h3", {}, t("gateway.correctionsTitle")),
        g.reportError ? el("div", { class: "bad-text" }, g.reportError) : el("label", { class: "muted" }, [openOnly, " " + t("gateway.openOnly")]),
        list,
        el("h3", {}, t("gateway.reconcileTitle")),
        reconciles.length ? el("div", {}, reconciles.slice(0, 10).map((r) => el("div", { style: "margin-bottom:6px" }, [
            el("span", { class: "muted" }, when(r.at) + " "),
            (r.differences || []).length ? el("span", {}, (r.differences || []).map((d) => short(d.account) + ": " + d.ledger + " → " + d.chain).join(" · "))
                : el("span", {}, t("gateway.noDifference"))
        ]))) : el("div", { class: "empty" }, t("gateway.noReconcile"))
    ]);
}

// ---- Nicknames page (docs/features/nicknames.md): the nickname collection (deploy it once), the price
// of a nickname, the edge levels (name, step price, for sale, style) with a live preview, reserved
// nicknames and the list of nicknames. Same gate and token as the Sections page; every change is
// signed by the contract account center through the proxy.

async function nicknamePut(path, body) {
    const response = await fetch(path, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer " + deployToken() },
        body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || ("HTTP " + response.status));
    }
    return data;
}

// A user level: its step price and whether it is for sale (level 0 is free and always for sale)
function levelEditor(level, onSave, saveLabel) {
    const isZero = level && level.level === 0;
    const price = el("input", { class: "table-search", value: level ? level.price : "", placeholder: "0.5", "aria-label": t("nick.stepPrice") });
    const forSale = el("input", { type: "checkbox", "aria-label": t("nick.forSale") });
    forSale.checked = level ? level.forSale : true;
    const save = el("button", { type: "button", class: "fn-run" }, saveLabel);
    const result = el("span", { class: "muted" });
    save.addEventListener("click", async () => {
        save.disabled = true;
        result.className = "muted";
        result.textContent = t("nick.signing");
        try {
            await onSave({ price: price.value.trim(), forSale: forSale.checked });
            render();
        } catch (error) {
            result.className = "bad-text";
            result.textContent = error.message;
            save.disabled = false;
        }
    });
    const field = (label, input) => el("label", {}, [el("span", { class: "muted" }, label), input]);
    return el("div", { class: "edge-editor" }, [
        el("div", { class: "edge-editor-head" }, [
            el("b", {}, level ? t("nick.level").replace("{n}", level.level) : t("nick.newLevel")),
            level ? el("span", { class: "muted" }, t("nick.holders").replace("{n}", level.holders || 0)) : null
        ]),
        el("div", { class: "edge-fields" }, isZero ? [el("span", { class: "muted" }, t("nick.level0"))]
            : [field(t("nick.stepPrice"), price)].concat(level ? [field(t("nick.forSale"), forSale)] : [])),
        isZero ? null : el("div", { class: "deploy-buttons" }, [save, result])
    ]);
}

async function showNicknames(q) {
    const token = showToken;
    const status = await api("/api/sections/status");
    if (token !== showToken) {
        return;
    }
    if (!status.enabled) {
        return show(el("section", { class: "card" }, [el("h2", {}, t("nick.title")), el("div", { class: "empty" }, t("nick.off"))]));
    }

    const message = el("div", { class: "deploy-error" });
    let data;
    try {
        data = deployToken() ? await sectionGet("/api/nicknames" + (q ? "?q=" + encodeURIComponent(q) : "")) : null;
    } catch (error) {
        if (error.status === 401) {
            setDeployToken("");
        }
        message.textContent = error.message;
    }
    if (token !== showToken) {
        return;
    }
    if (!data) {
        return show(el("section", { class: "card" }, [el("h2", {}, t("nick.title")), el("div", { class: "muted", style: "margin-bottom:12px" }, t("sections.needToken")), tokenBox(() => render()), message]));
    }

    if (!data.collection) {
        const f = {
            name: itemInput("nick.collectionName", { value: "Nicknames" }),
            symbol: itemInput("nick.symbol", { value: "NICK" }),
            holdDays: itemInput("item.holdDays", { value: "7" })
        };
        return show(el("section", { class: "card stack" }, [
            el("h2", {}, t("nick.title")),
            el("div", { class: "muted", style: "margin-bottom:12px" }, t("nick.noCollection")),
            itemForm(t("nick.deploy"), null, [["nick.collectionName", f.name], ["nick.symbol", f.symbol], ["item.holdDays", f.holdDays]], t("nick.deploy"), () => {
                if (!window.confirm(t("nick.confirmDeploy"))) {
                    throw new Error(t("item.cancelled"));
                }
                return deployPost("/api/nicknames/deploy", { name: f.name.value.trim(), symbol: f.symbol.value.trim(), holdDays: f.holdDays.value.trim() });
            }),
            message
        ]));
    }

    // mint names (one per line), change a price
    const names = el("textarea", { class: "table-search", rows: "3", placeholder: t("nick.mintPlaceholder"), "aria-label": t("nick.mintNames") });
    const mintPrice = itemInput("nft.price", { value: "1" });
    const mint = itemForm(t("nick.mintNames"), t("nick.mintNote"), [["nick.mintNames", names], ["nft.price", mintPrice]], t("nick.mintNames"), () => {
        const list = names.value.split("\n").map((x) => x.trim()).filter(Boolean);
        if (!list.length) {
            throw new Error(t("nick.mintNone"));
        }
        return deployPost("/api/nicknames/mint", { nicknames: list, price: mintPrice.value.trim() || "0" });
    }, (r) => {
        names.value = r.results.filter((x) => x.error).map((x) => x.nickname).join("\n");
        setTimeout(render, 1500);
        return r.results.map((x) => x.error ? x.nickname + ": " + x.error : x.nickname + " #" + x.tokenId).join(" · ");
    });
    const p = { tokenId: itemInput("nft.tokenId", { placeholder: "1" }), price: itemInput("nft.price") };
    const price = itemForm(t("item.setPrice"), t("item.setPriceNote"), [["nft.tokenId", p.tokenId], ["nft.price", p.price]], t("nick.save"),
        () => nicknamePut("/api/nicknames/price/" + encodeURIComponent(p.tokenId.value.trim()), { price: p.price.value.trim() }));

    // nicknames
    const search = el("input", { class: "table-search", value: q, placeholder: t("nick.search"), "aria-label": t("nick.search") });
    search.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            location.hash = "#/nicknames" + (search.value.trim() ? "?q=" + encodeURIComponent(search.value.trim()) : "");
        }
    });
    const list = dataTable([
        { label: "nft.tokenId", sort: (r) => Number(r.tokenId), cell: (r) => "#" + r.tokenId },
        { label: "nick.nickname", sort: (r) => r.nickname.toLowerCase(), search: (r) => r.nickname, cell: (r) => r.nickname },
        { label: "nft.price", sort: (r) => Number(r.price), cell: (r) => r.price + " ETH" },
        { label: "nick.account", search: (r) => r.owner, cell: (r) => (r.sold ? el("a", { href: "#/accounts/" + r.owner }, short(r.owner)) : el("span", { class: "muted" }, t("item.forSale"))) },
        { label: "nick.edge", sort: (r) => r.level, cell: (r) => (r.sold ? el("span", { class: "badge type" }, String(r.level)) : "—") },
        { label: "item.undo", cell: (r) => el("span", {}, [
            r.canUndo ? el("span", {}, [undoCell(r, false) + " ", undoButton(t("item.undo"), t("item.confirmUndo").replace("{id}", r.tokenId), "/api/nicknames/undo/" + r.tokenId)]) : null,
            r.canUndoLevel ? el("span", {}, [" " + undoCell(r, true) + " ", undoButton(t("item.undoLevel"), t("item.confirmUndoLevel").replace("{id}", r.tokenId), "/api/nicknames/undolevel/" + r.tokenId)]) : null,
            !r.canUndo && !r.canUndoLevel ? "—" : null
        ]) }
    ], data.list, { sort: 0, dir: "desc", key: "nicknames" });

    const c = data.collection;
    show(el("div", {}, [
        el("section", { class: "card stack" }, [
            el("div", { class: "card-head" }, [el("h2", {}, t("nick.title")),
                el("span", { class: "muted" }, [c.name + " (" + c.symbol + ") ", el("a", { href: "#/contracts/" + c.address }, short(c.address))])]),
            el("div", { class: "muted", style: "margin-bottom:12px" }, t("nick.summary").replace("{n}", data.minted).replace("{levels}", data.levels.length).replace("{days}", c.holdDays)),
            mint, price
        ]),
        el("section", { class: "card stack" }, [
            el("h2", {}, t("nick.edges")),
            el("div", { class: "muted", style: "margin-bottom:12px" }, t("nick.edgesNote")),
            el("div", { class: "edge-list" }, data.levels.map((l) => levelEditor(l, (v) => nicknamePut("/api/nicknames/levels/" + l.level, v), t("nick.save")))
                .concat([levelEditor(null, (v) => deployPost("/api/nicknames/levels", v), t("nick.add"))]))
        ]),
        el("section", { class: "card" }, [
            el("div", { class: "card-head" }, [el("h2", {}, t("nick.list")), search]),
            el("div", { class: "muted", style: "margin-bottom:8px" }, t("nick.listed").replace("{n}", data.list.length).replace("{m}", data.minted)),
            data.list.length ? list : el("div", { class: "empty" }, t("nick.none"))
        ]),
        message
    ]));
}

async function showSectionsNav() {
    try {
        const status = await api("/api/sections/status");
        document.querySelector("#nav-sections").hidden = !status.enabled;
        document.querySelector("#nav-nicknames").hidden = !status.enabled;
    } catch (error) {
        // stays hidden
    }
}

async function showDeployNav() {
    try {
        const status = await api("/api/deploy/status");
        document.querySelector("#nav-deploy").hidden = !status.enabled;
    } catch (error) {
        // stays hidden
    }
}

const TX_TYPES = ["call", "transfer", "create"];

function readTxFilter(params) {
    const types = [...new Set((params.get("type") || "").split(",").map((value) => value.trim()).filter((value) => TX_TYPES.includes(value)))];
    const from = Number(params.get("from")) || 0;
    const to = Number(params.get("to")) || 0;
    return { types, from: from > 0 ? from : 0, to: to > 0 ? to : 0 };
}

function txListHash(types, from, to) {
    const { params } = parseHash();
    const query = new URLSearchParams();
    const address = params.get("address") || "";

    if (types.length) {
        query.set("type", types.join(","));
    }

    if (from) {
        query.set("from", String(from));
    }

    if (to) {
        query.set("to", String(to));
    }

    if (address) {
        query.set("address", address);
    }

    const text = query.toString();
    return "#/transactions" + (text ? "?" + text : "");
}

function matchesTxFilter(tx, filter) {
    const timestamp = Number(tx.timestamp);

    if (filter.types.length && !filter.types.includes(tx.type)) {
        return false;
    }

    if (filter.from && timestamp < filter.from) {
        return false;
    }

    if (filter.to && timestamp > filter.to) {
        return false;
    }

    return true;
}

function localInputValue(unix) {
    const date = new Date(Number(unix) * 1000);
    const pad = (value) => String(value).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

function unixFromInput(value) {
    if (!value) {
        return 0;
    }

    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

function dateField(label, unix) {
    const input = el("input", { type: "datetime-local", step: "1", "aria-label": label });
    const icon = el("span", { class: "cal", "aria-hidden": "true" });
    icon.innerHTML = "<svg viewBox='0 0 16 16'><path fill='currentColor' d='M5 1.2h1.2V3h3.6V1.2H11V3h1.4A1.6 1.6 0 0 1 14 4.6v8.2A1.6 1.6 0 0 1 12.4 14.4H3.6A1.6 1.6 0 0 1 2 12.8V4.6A1.6 1.6 0 0 1 3.6 3H5V1.2zM3.2 6.2v6.6c0 .2.2.4.4.4h8.8c.2 0 .4-.2.4-.4V6.2H3.2z'/></svg>";
    const field = el("label", { class: "filter-date" }, [icon, input, el("span", { class: "ph" }, label)]);

    if (unix) {
        input.value = localInputValue(unix);
        field.classList.add("has-value");
    }

    const sync = () => field.classList.toggle("has-value", Boolean(input.value));
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
    return { field, input };
}

function txFilter(filter) {
    const boxes = TX_TYPES.map((type) => {
        const input = el("input", { type: "checkbox", value: type });
        input.checked = filter.types.includes(type);
        return { input, label: el("label", { class: "filter-check" }, [input, t(type === "call" ? "tx.call" : (type === "create" ? "tx.create" : "tx.transfer"))]) };
    });
    const from = dateField(t("tx.filterFrom"), filter.from);
    const to = dateField(t("tx.filterTo"), filter.to);
    const panel = el("div", { class: "filter-pop", hidden: "" }, [
        el("div", { class: "filter-label" }, t("tx.filterType")),
        el("div", { class: "filter-types" }, boxes.map((box) => box.label)),
        el("hr"),
        el("div", { class: "filter-label" }, t("tx.filterTime")),
        el("div", { class: "filter-times" }, [from.field, to.field]),
        el("div", { class: "filter-actions" }, [
            el("button", { type: "button", class: "filter-reset" }, t("tx.filterReset")),
            el("button", { type: "button", class: "filter-apply" }, t("tx.filterApply"))
        ])
    ]);
    const button = el("button", { type: "button", class: "filter-btn" + (filter.types.length || filter.from || filter.to ? " on" : ""), "aria-expanded": "false", "aria-label": t("tx.filter") }, [t("tx.filter"), el("span", { class: "caret", "aria-hidden": "true" })]);
    const wrap = el("div", { class: "filter" }, [button, panel]);

    const setOpen = (open) => {
        panel.hidden = !open;
        button.classList.toggle("open", open);
        button.setAttribute("aria-expanded", open ? "true" : "false");
    };

    button.addEventListener("click", (event) => {
        event.stopPropagation();
        setOpen(panel.hidden);
    });
    panel.querySelector(".filter-reset").addEventListener("click", () => {
        for (const box of boxes) {
            box.input.checked = false;
        }

        from.input.value = "";
        to.input.value = "";
        from.field.classList.remove("has-value");
        to.field.classList.remove("has-value");
    });
    panel.querySelector(".filter-apply").addEventListener("click", () => {
        let start = unixFromInput(from.input.value);
        let end = unixFromInput(to.input.value);

        if (start && end && start > end) {
            const swap = start;
            start = end;
            end = swap;
        }

        const next = txListHash(boxes.filter((box) => box.input.checked).map((box) => box.input.value), start, end);

        if (next === location.hash) {
            setOpen(false);
            return;
        }

        location.hash = next;
    });
    return wrap;
}

document.addEventListener("click", (event) => {
    const pop = document.querySelector(".filter-pop:not([hidden])");

    if (!pop || pop.parentElement.contains(event.target)) {
        return;
    }

    pop.hidden = true;
    const button = pop.parentElement.querySelector(".filter-btn");
    button.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
});

async function showTxs(page, status) {
    const token = showToken;
    const { params } = parseHash();
    const address = params.get("address") || "";
    const filter = readTxFilter(params);
    const data = await api("/api/transactions?limit=20000" + (address ? "&address=" + encodeURIComponent(address) : ""));

    if (token !== showToken) {
        return;
    }
    const items = data.items.filter((tx) => matchesTxFilter(tx, filter));
    show(el("section", { class: "card" }, [
        notice(status),
        el("div", { class: "card-head" }, [el("h2", {}, t("tx.title")), txFilter(filter)]),
        data.items.length ? txTable(items, "txs") : el("div", { class: "empty" }, t("tx.none"))
    ]));
}

async function showTx(hash) {
    const token = showToken;
    const tx = await api("/api/transactions/" + hash);

    if (token !== showToken) {
        return;
    }
    const body = el("div");
    const tabs = el("div", { class: "tabs" });

    function draw(name) {
        txTab = name;
        body.replaceChildren();

        if (name === "events") {
            if (!tx.events.length) {
                body.append(el("div", { class: "empty" }, t("tx.noEvents")));
            } else {
                tx.events.forEach((event, index) => {
                    body.append(el("h3", {}, event.name));
                    body.append(argsTable(event.args, "tx-ev-" + index));
                });
            }
        } else if (tx.decoded) {
            body.append(el("h3", {}, tx.decoded.name));
            body.append(argsTable(tx.decoded.args, "tx-fn"));
        } else {
            body.append(el("div", { class: "kv" }, [
                el("span", {}, t("tx.function")), fnLabel(tx.functionName) || "—"
            ]));
        }

        for (const button of tabs.children) {
            button.classList.toggle("active", button.dataset.tab === name);
        }
    }

    tabs.append(
        el("button", { type: "button", "data-tab": "function", onclick: () => draw("function") }, t("tx.function")),
        el("button", { type: "button", "data-tab": "events", onclick: () => draw("events") }, t("tx.events"))
    );
    draw(txTab || "function");
    const to = tx.to
        ? (tx.toLabel ? contractLink(tx.toLabel, tx.to, "#/contracts/" + tx.to) : addr(tx.to))
        : (tx.contractAddress ? ident(tx.contractAddress, "#/contracts/" + tx.contractAddress) : el("span", {}, "—"));

    show(el("div", {}, [
        el("div", { class: "muted", style: "margin-bottom:10px" }, [
            el("a", { href: "#/transactions" }, t("tx.title")),
            " / ",
            copyValue(tx.hash)
        ]),
        el("div", { class: "detail" }, [
            el("section", { class: "card" }, [
                el("h2", {}, [t("tx.details") + " ", badge(tx.type)]),
                el("div", { style: "word-break:break-all;margin:8px 0" }, copyValue(tx.hash)),
                el("div", {}, [
                    t("tx.block") + " ",
                    el("a", { href: "#/blocks/" + tx.blockNumber }, "#" + tx.blockNumber),
                    "  " + t("tx.time") + " " + ago(tx.timestamp)
                ]),
                el("div", { style: "margin-top:8px" }, [t("tx.from") + " ", addr(tx.from), "  " + t("tx.to") + " ", to]),
                el("div", { style: "margin-top:8px" }, t("tx.status") + " " + (tx.status === "success" ? t("tx.ok") : t("tx.fail"))),
                tx.type === "transfer"
                    ? el("div", { class: "memo", style: "margin-top:8px" }, [t("tx.memo") + " ", ...(tx.memo ? memoNodes(tx.memo) : ["—"])])
                    : null
            ]),
            el("aside", { class: "side-stat" }, [el("div", {}, t("tx.value")), el("b", {}, tx.value + " ETH")])
        ]),
        el("section", { class: "card stack" }, [tabs, body])
    ]));
}

function argsTable(args, key) {
    return dataTable([
        { label: "col.name", sort: (row) => row.name || "", cell: (row) => row.name },
        { label: "col.value", sort: (row) => row.value || "", cell: (row) => /^0x[0-9a-fA-F]{40,}$/.test(row.value || "") ? addressTip(el("span", { style: "word-break:break-all" }, row.value), [{ value: row.value }]) : el("span", { style: "word-break:break-all" }, row.value) }
    ], args || [], { key });
}

async function showBlocks(page, status) {
    const token = showToken;
    const data = await api("/api/blocks?limit=20000");

    if (token !== showToken) {
        return;
    }
    const table = dataTable([
        { label: "col.blockNumber", sort: (row) => row.number || 0, cell: (row) => el("a", { href: "#/blocks/" + row.number }, String(row.number)) },
        { label: "col.hash", sort: (row) => row.hash, cell: (row) => ident(row.hash, "#/blocks/" + row.number) },
        { label: "col.txCount", sort: (row) => row.txCount || 0, cell: (row) => String(row.txCount) },
        { label: "col.time", sort: (row) => row.timestamp || 0, search: (row) => stamp(row.timestamp), cell: (row) => stamp(row.timestamp) }
    ], data.items, { sort: 0, dir: "desc", page, key: "blocks" });
    show(el("section", { class: "card" }, [
        notice(status),
        el("h2", {}, t("blocks.title")),
        table
    ]));
}

async function showBlock(number) {
    const token = showToken;
    const block = await api("/api/blocks/" + number);

    if (token !== showToken) {
        return;
    }
    show(el("section", { class: "card" }, [
        el("h2", {}, t("block.title", { n: block.number })),
        el("div", { class: "kv" }, [
            el("span", {}, t("block.hash")), copyValue(block.hash),
            el("span", {}, t("block.tx")), String(block.txCount),
            el("span", {}, t("block.time")), ago(block.timestamp)
        ]),
        el("h2", { class: "stack" }, t("tx.title")),
        block.transactions.length ? txTable(block.transactions, "block-tx") : el("div", { class: "empty" }, t("block.none"))
    ]));
}

async function showNetwork() {
    const token = showToken;
    const data = await api("/api/network");

    if (token !== showToken) {
        return;
    }
    const enodeRow = el("div");
    const viewLink = el("button", { type: "button", class: "linkish" }, t("net.view"));
    viewLink.addEventListener("click", () => {
        enodeOpen = !enodeOpen;
        enodeRow.textContent = enodeOpen ? data.enode : "";
    });
    if (enodeOpen) {
        enodeRow.textContent = data.enode;
    }
    const table = dataTable([
        { label: "col.id", sort: (row) => row.id || "", cell: (row) => short(row.id) },
        { label: "col.name", sort: (row) => row.name || "", cell: (row) => row.name || "" },
        { label: "col.address", sort: (row) => row.address || "", cell: (row) => row.address || "" }
    ], data.peers, { key: "peers" });
    const noAdmin = data.adminApi === false;
    const noAdminNote = () => el("div", { class: "empty" }, t("net.noAdmin"));
    show(el("div", {}, [
        el("div", { class: "detail" }, [
            noAdmin ? el("section", { class: "card" }, [el("h2", {}, t("net.node")), noAdminNote()]) : el("section", { class: "card" }, [
                el("h2", {}, t("net.node")),
                el("div", { class: "kv" }, [
                    el("span", {}, t("net.name")), data.name || "—",
                    el("span", {}, t("net.enode")), viewLink,
                    el("span", {}, t("net.address")), data.address || "—"
                ]),
                enodeRow
            ]),
            el("aside", { class: "side-stat" }, [el("div", {}, t("net.count")), el("b", {}, String(data.peerCount))])
        ]),
        el("section", { class: "card stack" }, [el("h2", {}, t("net.peers")), noAdmin ? noAdminNote() : table])
    ]));
}

function showApi() {
    const rows = [
        ["GET", "/api/status", t("api.status")],
        ["GET", "/api/dashboard", t("api.dashboard")],
        ["GET", "/api/accounts", t("api.accounts")],
        ["GET", "/api/accounts/:address", t("api.account")],
        ["GET", "/api/contracts/:address", t("api.contract")],
        ["POST", "/api/contracts/:address/call", t("api.contractCall")],
        ["POST", "/api/deploy/inspect, /check, /send", t("api.deploy")],
        ["GET", "/api/nfts", t("api.nfts")],
        ["GET", "/api/transactions", t("api.transactions")],
        ["GET", "/api/blocks", t("api.blocks")],
        ["GET", "/api/network", t("api.network")]
    ];
    const table = dataTable([
        { label: "col.method", sort: (row) => row[0], cell: (row) => row[0] },
        { label: "col.path", sort: (row) => row[1], cell: (row) => row[1] },
        { label: "col.description", sort: (row) => row[2], cell: (row) => row[2] }
    ], rows, { key: "api" });
    show(el("section", { class: "card" }, [el("h2", {}, t("api.title")), table]));
}

window.addEventListener("hashchange", render);
showDeployNav();
showSectionsNav();
document.addEventListener("localechange", () => {
    themeButton.setAttribute("aria-label", t(document.body.classList.contains("light") ? "theme.dark" : "theme.light"));
    render({ refresh: true });
});
render();

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
    root.append(el("div", { class: "table-bar" }, input), host);

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
        host.replaceChildren(pager("top"), table, pager());
        remember();
    }

    paint();
    return root;
}

function txTo(tx) {
    if (tx.to) {
        return tx.toLabel ? contractLink(tx.toLabel, tx.to, "#/contracts") : addr(tx.to);
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
    const mint = memo.match(/^New NFT Token mint: [\s\S]* - (https?:\/\/\S+)$/);

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
            const memo = tx.type === "transfer" ? (tx.memo || "") : "";
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
    if (document.hidden) {
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

async function showDashboard(status) {
    const token = showToken;
    const data = await api("/api/dashboard?from=" + encodeURIComponent(chartStart) + "&to=" + encodeURIComponent(chartEnd));

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
        { label: "col.address", sort: (row) => row.label || row.address, search: (row) => row.label + " " + row.address, cell: (row) => contractLink(row.label, row.address, "#/transactions?address=" + row.address) },
        { label: "col.type", sort: (row) => row.type, cell: (row) => el("span", { class: "badge type" }, row.type) },
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

async function showAccounts(page, status) {
    const token = showToken;
    const data = await api("/api/accounts?limit=20000");

    if (token !== showToken) {
        return;
    }
    const table = dataTable([
        { label: "col.address", sort: (row) => row.address, cell: (row) => addr(row.address) },
        { label: "col.balance", sort: (row) => BigInt(row.balanceWei || 0), search: (row) => row.balance, cell: (row) => row.balance },
        { label: "col.totalTokens", sort: (row) => row.tokens || 0, cell: (row) => String(row.tokens) },
        { label: "col.totalNfts", sort: (row) => row.nfts || 0, cell: (row) => String(row.nfts) },
        { label: "col.transactions", sort: (row) => row.transactions || 0, cell: (row) => String(row.transactions) }
    ], data.items, { sort: 1, dir: "desc", page, key: "accounts" });
    show(el("section", { class: "card" }, [
        notice(status),
        el("h2", {}, t("accounts.title")),
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
                el("div", { style: "margin-top:8px" }, copyValue(data.address))
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
        { label: "col.address", sort: (row) => row.label || row.address, search: (row) => row.label + " " + row.address, cell: (row) => contractLink(row.label, row.address, "#/transactions?address=" + row.address) },
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
        ? (tx.toLabel ? contractLink(tx.toLabel, tx.to, "#/transactions?address=" + tx.to) : addr(tx.to))
        : (tx.contractAddress ? ident(tx.contractAddress, "#/transactions?address=" + tx.contractAddress) : el("span", {}, "—"));

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
    show(el("div", {}, [
        el("div", { class: "detail" }, [
            el("section", { class: "card" }, [
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
        el("section", { class: "card stack" }, [el("h2", {}, t("net.peers")), table])
    ]));
}

function showApi() {
    const rows = [
        ["GET", "/api/status", t("api.status")],
        ["GET", "/api/dashboard", t("api.dashboard")],
        ["GET", "/api/accounts", t("api.accounts")],
        ["GET", "/api/accounts/:address", t("api.account")],
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
document.addEventListener("localechange", () => {
    themeButton.setAttribute("aria-label", t(document.body.classList.contains("light") ? "theme.dark" : "theme.light"));
    render({ refresh: true });
});
render();

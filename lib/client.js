window.__ModuleLoader__.load({
	id: "aihub-checkin",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// 整个工厂体包在 try 里：任何一步失败都退化成「什么都不注册」，不拖累客户端引导。
		try {
			var jsx = require("react/jsx-runtime").jsx;
			var React = require("react");
			var useState = React.useState;
			var useEffect = React.useEffect;
			var ENDPOINT = "/aihub-checkin/status";
			var CONFIG = "/aihub-checkin/config";
			var POLL_MS = 60000;

			/** 正确的元素构造：children 必须进 props（jsx 只有 type/props/key 三个参数）。 */
			function el(type, props, children) {
				var p = props ? Object.assign({}, props) : {};
				if (children !== undefined && children !== null) p.children = children;
				return jsx(type, p);
			}

			/* ── 像素图 ─────────────────────────────────────────────── */
			var CRYSTAL_ROWS = [
				"   D   ",
				"  DLD  ",
				" DLLLD ",
				"DLLLLLD",
				" DLLLD ",
				"  DLD  ",
				"   D   "
			];
			// 蜘蛛轮廓：11×11，八条腿 + 椭圆身体（只用 # 描边，不填色）
			var BUG_ROWS = [
				"...........",
				".#.......#.",
				"..#.....#..",
				"...#####...",
				".#.#...#.#.",
				"...#...#...",
				".#.#...#.#.",
				"...#####...",
				"..#.....#..",
				".#.......#.",
				"..........."
			];
			var CORE = [];
			for (var cy = CRYSTAL_ROWS.length - 1; cy >= 0; cy -= 1) {
				for (var cx = 0; cx < CRYSTAL_ROWS[cy].length; cx += 1) {
					if (CRYSTAL_ROWS[cy].charAt(cx) === "L") CORE.push({ x: cx, y: cy });
				}
			}
			var TONES = {
				green: { ring: "#15803d", core: "#4ade80" },
				amber: { ring: "#b45309", core: "#fbbf24" }
			};
			var cache = {};

			/** 完成度 → 点亮档位：0 / 1/3 / 1/2 / 2/3 / 1 */
			function fillLevel(done, total) {
				if (!total || done <= 0) return 0;
				var r = done / total;
				if (r >= 1) return 1;
				if (Math.abs(r - 0.5) < 1e-9) return 0.5;
				return r < 0.5 ? 1 / 3 : 2 / 3;
			}

			function svgUri(rows, pick) {
				var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + rows[0].length + '" height="' + rows.length + '" viewBox="0 0 ' + rows[0].length + " " + rows.length + '" shape-rendering="crispEdges">'];
				for (var y = 0; y < rows.length; y += 1) {
					for (var x = 0; x < rows[y].length; x += 1) {
						var ch = rows[y].charAt(x);
						if (ch === " " || ch === ".") continue;
						var fill = pick(ch, x, y);
						if (!fill) continue;
						parts.push('<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="' + fill + '"/>');
					}
				}
				parts.push("</svg>");
				return 'url("data:image/svg+xml,' + encodeURIComponent(parts.join("")) + '")';
			}

			/** 水晶：level 决定内芯亮几格。 */
			function crystal(level, tone) {
				try {
					var key = "c:" + tone + ":" + level;
					if (cache[key]) return cache[key];
					var pair = TONES[tone] || TONES.green;
					var litCount = Math.round(level * CORE.length);
					var lit = {};
					for (var i = 0; i < litCount; i += 1) lit[CORE[i].x + "," + CORE[i].y] = true;
					var full = level >= 1;
					var uri = svgUri(CRYSTAL_ROWS, function (ch, x, y) {
						if (ch === "D") return full ? pair.ring : "#6b7280";
						return lit[x + "," + y] ? pair.core : "#cbd5e1";
					});
					cache[key] = uri;
					return uri;
				} catch (e) {
					return "none";
				}
			}

			/** 像素小虫（设置页的图标）。 */
			function bug() {
				try {
					if (cache.bug) return cache.bug;
					var uri = svgUri(BUG_ROWS, function () { return "#22c55e"; });
					cache.bug = uri;
					return uri;
				} catch (e) {
					return "none";
				}
			}

			/* ── 水晶角标 ───────────────────────────────────────────── */
			function paint(node, data) {
				try {
					if (!node || !node.style) return;
					var tasks = data && data.tasks ? data.tasks : null;
					var total = tasks ? Number(tasks.total) || 0 : 1;
					var done = tasks ? Number(tasks.done) || 0 : data && data.doneToday ? 1 : 0;
					var level = fillLevel(done, total);
					var tone = data && data.loginState === "expired" ? "amber" : "green";
					node.style.display = "inline-block";
					node.style.width = "14px";
					node.style.height = "14px";
					node.style.backgroundImage = crystal(level, tone);
					node.style.backgroundRepeat = "no-repeat";
					node.style.backgroundPosition = "center";
					node.style.backgroundSize = "14px 14px";
					node.style.imageRendering = "pixelated";
					var title = (data && data.title) || "CaoPazi状态";
					if (total > 0) title = "已完成 " + done + "/" + total + " · " + title;
					node.title = title;
					node.setAttribute("aria-label", title);
				} catch (e) {}
			}

			function refresh(node) {
				try {
					fetch(ENDPOINT, { headers: { accept: "application/json" }, cache: "no-store" })
						.then(function (res) { return res.ok ? res.json() : null })
						.then(function (data) { paint(node, data) })
						.catch(function () {});
				} catch (e) {}
			}

			function Badge() {
				var timer = null;
				function attach(node) {
					try {
						if (timer !== null) {
							clearInterval(timer);
							timer = null;
						}
						if (!node) return;
						refresh(node);
						timer = setInterval(function () { refresh(node); }, POLL_MS);
					} catch (e) {}
				}
				return el("span", {
					ref: attach,
					"data-aihub-badge": "1",
					style: {
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						width: "16px",
						height: "16px",
						backgroundImage: crystal(0, "green"),
						backgroundRepeat: "no-repeat",
						backgroundPosition: "center",
						backgroundSize: "14px 14px",
						imageRendering: "pixelated",
						cursor: "default"
					}
				});
			}

			/* ── 设置页 ─────────────────────────────────────────────── */
			var rowStyle = { display: "flex", alignItems: "center", gap: "10px", margin: "10px 0" };
			var labelStyle = { width: "84px", flex: "0 0 auto", opacity: 0.75, fontSize: "13px" };
			var inputStyle = {
				flex: "1 1 auto",
				minWidth: "0",
				padding: "6px 8px",
				fontSize: "13px",
				color: "inherit",
				background: "transparent",
				border: "1px solid rgba(128,128,128,0.35)",
				borderRadius: "6px"
			};
			var btnStyle = {
				padding: "7px 16px",
				fontSize: "13px",
				color: "inherit",
				background: "rgba(128,128,128,0.14)",
				border: "1px solid rgba(128,128,128,0.35)",
				borderRadius: "6px",
				cursor: "pointer"
			};

			function Row(props) {
				return el("div", { style: rowStyle }, [
					el("span", { key: "l", style: labelStyle }, props.label),
					props.children
				]);
			}

			function Field(props) {
				return el("input", {
					type: props.type || "text",
					value: props.value === undefined ? "" : props.value,
					placeholder: props.placeholder || "",
					style: inputStyle,
					onChange: props.onChange
				});
			}

			function Settings() {
				var c = useState(null);
				var cfg = c[0];
				var setCfg = c[1];
				var m = useState("");
				var msg = m[0];
				var setMsg = m[1];
				var b = useState(false);
				var busy = b[0];
				var setBusy = b[1];

				function load() {
					try {
						fetch(CONFIG, { headers: { accept: "application/json" }, cache: "no-store" })
							.then(function (r) { return r.json(); })
							.then(function (d) {
								if (d && d.ok) setCfg(d.settings);
								else setMsg("读取失败");
							})
							.catch(function () { setMsg("读取失败（接口不可用）"); });
					} catch (e) {}
				}

				useEffect(function () { load(); }, []);

				function update(fn) {
					try {
						var next = JSON.parse(JSON.stringify(cfg));
						fn(next);
						setCfg(next);
					} catch (e) {}
				}

				function save() {
					if (!cfg) return;
					setBusy(true);
					setMsg("");
					try {
						fetch(CONFIG, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(cfg)
						})
							.then(function (r) { return r.json(); })
							.then(function (d) {
								if (d && d.ok) {
									setMsg("已保存");
									setCfg(d.settings);
								} else setMsg("保存失败：" + ((d && d.message) || "未知"));
							})
							.catch(function () { setMsg("保存失败：网络错误"); })
							.finally(function () { setBusy(false); });
					} catch (e) {
						setBusy(false);
					}
				}

				if (!cfg) {
					return el("div", { style: { fontSize: "13px", padding: "8px 0", opacity: 0.7 } }, msg || "加载中…");
				}

				var seat = cfg.seat || {};
				return el("div", { style: { fontSize: "14px", padding: "4px 0" } }, [
					el("div", { key: "hd", style: { display: "flex", alignItems: "center", gap: "10px", margin: "4px 0 10px" } }, [
						el("span", {
							key: "bug",
							style: {
								width: "22px",
								height: "22px",
								display: "inline-block",
								backgroundImage: bug(),
								backgroundRepeat: "no-repeat",
								backgroundPosition: "center",
								backgroundSize: "22px 22px",
								imageRendering: "pixelated"
							}
						}),
						el("span", { key: "t", style: { fontWeight: 600, fontSize: "15px" } }, "CaoPazi"),
						el("span", { key: "s", style: { fontSize: "12px", opacity: 0.55 } }, "签到 · 抢座")
					]),

					el("div", { key: "h1", style: { fontWeight: 600, margin: "14px 0 2px" } }, "AI Hub 签到"),
					el(Row, { key: "r1", label: "启用" }, [
						el("input", {
							key: "cb",
							type: "checkbox",
							checked: cfg.enabled !== false,
							onChange: function (e) { var v = e.target.checked; update(function (n) { n.enabled = v; }); }
						}),
						el("span", { key: "t", style: { fontSize: "13px", opacity: 0.7 } }, "每天自动签到")
					]),
					el(Row, { key: "r2", label: "签到时间" }, [
						el(Field, {
							key: "i",
							type: "time",
							value: cfg.time || "07:00",
							onChange: function (e) { var v = e.target.value; update(function (n) { n.time = v; }); }
						})
					]),

					el("div", { key: "h2", style: { fontWeight: 600, margin: "20px 0 2px" } }, "图书馆抢座"),
					el(Row, { key: "r3", label: "启用" }, [
						el("input", {
							key: "cb",
							type: "checkbox",
							checked: seat.enabled === true,
							onChange: function (e) { var v = e.target.checked; update(function (n) { n.seat.enabled = v; }); }
						}),
						el("span", { key: "t", style: { fontSize: "13px", opacity: 0.7 } }, "每天抢次日座位")
					]),
					el(Row, { key: "r4", label: "开抢时间" }, [
						el(Field, {
							key: "i",
							type: "time",
							value: seat.openTime || "07:00",
							onChange: function (e) { var v = e.target.value; update(function (n) { n.seat.openTime = v; }); }
						})
					]),
					el(Row, { key: "r5", label: "使用时段" }, [
						el(Field, {
							key: "s",
							type: "time",
							value: seat.startTime || "07:30",
							onChange: function (e) { var v = e.target.value; update(function (n) { n.seat.startTime = v; }); }
						}),
						el("span", { key: "d", style: { opacity: 0.5 } }, "—"),
						el(Field, {
							key: "e",
							type: "time",
							value: seat.endTime || "22:00",
							onChange: function (e) { var v = e.target.value; update(function (n) { n.seat.endTime = v; }); }
						})
					]),
					el(Row, { key: "r5b", label: "特殊时段" }, [
						el(Field, {
							key: "i",
							value: seat.overrides || "",
							placeholder: "4=10:00-22:00（周四）",
							onChange: function (e) { var v = e.target.value; update(function (n) { n.seat.overrides = v; }); }
						})
					]),
					el(Row, { key: "r6", label: "优先座位" }, [
						el(Field, {
							key: "i",
							value: (seat.preferred || []).join(","),
							placeholder: "3F-B004,3F-B010",
							onChange: function (e) {
								var list = e.target.value.split(/[,，\s]+/).filter(Boolean);
								update(function (n) { n.seat.preferred = list; });
							}
						})
					]),
					el(Row, { key: "r7", label: "兜底规则" }, [
						el("select", {
							key: "sel",
							value: seat.parity || "",
							style: inputStyle,
							onChange: function (e) { var v = e.target.value; update(function (n) { n.seat.parity = v; }); }
						}, [
							el("option", { key: "even", value: "even" }, "尾数偶数"),
							el("option", { key: "odd", value: "odd" }, "尾数奇数"),
							el("option", { key: "any", value: "" }, "不限")
						]),
						el("span", { key: "t", style: { fontSize: "12px", opacity: 0.6 } }, "就近 " + (seat.maxDistance || 3) + " 格")
					]),
					el(Row, { key: "r8", label: "学工号" }, [
						el(Field, {
							key: "i",
							value: seat.user || "",
							onChange: function (e) { var v = e.target.value; update(function (n) { n.seat.user = v; }); }
						})
					]),
					el(Row, { key: "r9", label: "密码" }, [
						el(Field, {
							key: "i",
							type: "password",
							value: "",
							placeholder: seat.passSet ? "已保存（留空不改）" : "未设置",
							onChange: function (e) { var v = e.target.value; update(function (n) { n.seat.pass = v; }); }
						})
					]),

					el("div", { key: "act", style: { display: "flex", alignItems: "center", gap: "12px", marginTop: "18px" } }, [
						el("button", { key: "b", style: btnStyle, disabled: busy, onClick: save }, busy ? "保存中…" : "保存"),
						el("span", { key: "m", style: { fontSize: "12px", opacity: 0.7 } }, msg)
					]),
					el("div", { key: "tip", style: { fontSize: "12px", opacity: 0.55, marginTop: "12px", lineHeight: 1.6 } },
						"保存后立即生效，不需要重启。")
				]);
			}

			function apply(ctx) {
				try {
					ctx.slots.inject("sidebar.footer.action", function () {
						return ctx.slots.register({
							name: "sidebar.footer.action",
							id: "aihub-checkin-badge",
							label: "CaoPazi",
							order: 50
						}, Badge);
					});
				} catch (e) {
					try { console.error("[aihub-checkin] badge registration failed:", e); } catch (_) {}
				}
				try {
					ctx.slots.inject("settings.section", function () {
						return ctx.slots.register({
							name: "settings.section",
							id: "aihub-checkin",
							order: 60,
							label: "CaoPazi"
						}, Settings);
					});
				} catch (e) {
					try { console.error("[aihub-checkin] settings registration failed:", e); } catch (_) {}
				}
			}

			module.exports.apply = apply;
			module.exports.inject = ["slots"];
		} catch (e) {
			try { console.error("[aihub-checkin] client bundle failed to initialise:", e); } catch (_) {}
		}
		if (typeof module.exports.apply !== "function") module.exports.apply = function () {};
		if (!module.exports.inject) module.exports.inject = [];
		return module.exports;
	}
});

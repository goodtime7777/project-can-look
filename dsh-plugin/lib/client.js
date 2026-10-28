window.__ModuleLoader__.load({
	id: "dsh-projectmap",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * 这个客户端模块只做一件事：把「打开地图」这个动作交给页面上的浮动按钮。
		 * 不注册任何 UI，所以它出错也不会影响 DSH 界面本身。
		 */
		const inject = ["sidebarRight", "sidebarRightTabs"];

		function apply(ctx) {
			const openInSidebar = (url) => {
				const tabs = ctx.get("sidebarRightTabs");
				if (tabs && tabs.get && tabs.get("browser")) {
					ctx.sidebarRight.openTab("browser", { params: { url } });
					return true;
				}
				return false;
			};

			window.__dshProjectMap = {
				open(url) {
					try {
						if (!openInSidebar(url)) window.open(url, "_blank", "noopener");
					} catch (err) {
						try { window.open(url, "_blank", "noopener"); } catch { /* 弹窗被拦 */ }
					}
				},
			};

			ctx.effect(() => () => {
				try { delete window.__dshProjectMap; } catch { /* 忽略 */ }
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

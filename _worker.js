// 'use strict' 保持不变，它是一个指令
'use strict';

// ====================================================================
// 配置部分 - 请根据您的实际需求调整
// ====================================================================

// 屏蔽爬虫UA列表
// 注意：在 EdgeOne Pages 中，环境变量的获取方式可能与 Cloudflare Workers 不同。
// 如果 env.UA 不可用，您可能需要在这里硬编码或通过其他方式获取。
let 屏蔽爬虫UA = ['netcraft'];

// 路由前缀
// 如果您的 EdgeOne Pages 部署在子路径下，例如 `example.com/gh/*`，则改为 '/gh/'
// 如果您的函数文件是 `functions/index.js` 并处理所有请求，通常 PREFIX 保持 '/'
const PREFIX = '/' // 路由前缀

// 分支文件使用jsDelivr镜像的开关，0为关闭，1为开启
const Config = {
    jsdelivr: 0 // 配置是否使用jsDelivr镜像
}

// 白名单，路径中包含白名单字符的请求才会通过，例如 ['/username/']
// 如果白名单为空数组，则所有请求都通过
const whiteList = []

// ====================================================================
// 常量和辅助函数 - 通常无需修改
// ====================================================================

/** @type {ResponseInit} */
const PREFLIGHT_INIT = {
    status: 204, // 响应状态码
    headers: new Headers({
        'access-control-allow-origin': '*', // 允许所有来源
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS', // 允许的HTTP方法
        'access-control-max-age': '1728000', // 预检请求的缓存时间
    }),
}

// GitHub URL 匹配正则表达式
const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i // 匹配GitHub的releases或archive路径
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i // 匹配GitHub的blob或raw路径
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i // 匹配GitHub的info或git-路径
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i // 匹配raw.githubusercontent.com的路径
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i // 匹配Gist的路径
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i // 匹配GitHub的tags路径

/**
 * 创建响应对象
 * @param {any} body - 响应体
 * @param {number} status - 状态码
 * @param {Object<string, string>} headers - 响应头
 */
function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*' // 设置跨域头
    return new Response(body, { status, headers }) // 返回新的响应
}

/**
 * 创建URL对象
 * @param {string} urlStr - URL字符串
 */
function newUrl(urlStr) {
    try {
        return new URL(urlStr) // 尝试创建URL对象
    } catch (err) {
        // console.error("Invalid URL:", urlStr, err); // 调试时可以打开
        return null // 如果失败，返回null
    }
}

/**
 * 检查URL是否匹配白名单中的正则表达式
 * @param {string} u - 待检查的URL
 */
function checkUrl(u) {
    for (let i of [exp1, exp2, exp3, exp4, exp5, exp6]) {
        if (u.search(i) === 0) {
            return true // 如果匹配，返回true
        }
    }
    return false // 如果不匹配，返回false
}

/**
 * 处理HTTP请求
 * @param {Request} req - 请求对象
 * @param {string} pathname - 请求路径 (此处的 pathname 应该是一个完整的 URL 字符串，如 "https://github.com/user/repo/...")
 */
async function httpHandler(req, pathname) {
    // console.log("httpHandler received pathname:", pathname); // 调试日志

    const reqHdrRaw = req.headers

    // 处理预检请求
    if (req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT) // 返回预检响应
    }

    const reqHdrNew = new Headers(reqHdrRaw)

    // 修改Accept-Language请求头，将zh-CN替换为zh-SG
    if (reqHdrNew.has('accept-language')) {
        const acceptLanguage = reqHdrNew.get('accept-language')
        const modifiedAcceptLanguage = acceptLanguage.replace('zh-CN', 'zh-SG')
        reqHdrNew.set('accept-language', modifiedAcceptLanguage)
    }

    // 白名单检查
    // 注意：这里的 urlStr 是传入的完整目标 URL 字符串，而非原始请求的 pathname
    let flag = !Boolean(whiteList.length) // 如果白名单为空，默认允许
    for (let i of whiteList) {
        if (pathname.includes(i)) { // 使用传入的 pathname 进行检查
            flag = true // 如果路径包含白名单中的任意项，允许请求
            break
        }
    }
    if (!flag) {
        // console.log("Blocked by whiteList:", pathname); // 调试日志
        return new Response("blocked", { status: 403 }) // 不在白名单中，返回403
    }

    // 确保 pathname 是一个完整的 HTTPS URL
    let urlToProxy = pathname;
    if (urlToProxy.search(/^https?:\/\//) !== 0) {
        urlToProxy = 'https://' + urlToProxy;
    }
    const urlObj = newUrl(urlToProxy);

    if (!urlObj) {
        // console.error("httpHandler: Failed to create URL object for:", urlToProxy); // 调试日志
        return new Response("Bad Request: Invalid URL format", { status: 400 });
    }

    /** @type {RequestInit} */
    const reqInit = {
        method: req.method, // 请求方法
        headers: reqHdrNew, // 请求头
        redirect: 'manual', // 手动处理重定向
        body: req.body // 请求体
    }
    return proxy(urlObj, reqInit) // 代理请求
}

/**
 * 实际执行代理请求并处理响应
 * @param {URL} urlObj - 目标URL对象
 * @param {RequestInit} reqInit - 请求初始化对象
 */
async function proxy(urlObj, reqInit) {
    // console.log("Proxying to:", urlObj.href); // 调试日志
    try {
        const res = await fetch(urlObj.href, reqInit) // 发送请求并获取响应
        const resHdrOld = res.headers
        const resHdrNew = new Headers(resHdrOld)

        const status = res.status

        if (resHdrNew.has('location')) { // 如果响应包含重定向
            let _location = resHdrNew.get('location')
            // console.log("Original redirect location:", _location); // 调试日志
            if (_location && checkUrl(_location)) { // 检查重定向URL是否仍然是GitHub相关
                // 修改重定向URL，使其通过Pages Functions再次代理
                // 这里需要特别注意，EdgeOne Pages 的最终 URL 结构
                // 如果你的 Pages 域名是 mypages.com，PREFIX 是 /
                // 那么重定向到 mypages.com/https://github.com/...
                // 客户端会再次向 mypages.com 发起请求
                // Cloudflare Workers 会自动处理 `//` 合并，EdgeOne Pages 也应该类似
                resHdrNew.set('location', urlObj.origin + PREFIX + _location.replace(/^https?:\/\//, ''));
                // console.log("Modified redirect location:", resHdrNew.get('location')); // 调试日志
            } else {
                // 如果重定向到非GitHub链接，则让 fetch 自动跟随
                // console.log("Redirecting to non-GitHub URL, following automatically."); // 调试日志
                reqInit.redirect = 'follow'
                // 递归处理，直到获取最终响应或遇到非HTTP/S协议的重定向
                return proxy(newUrl(_location), reqInit)
            }
        }
        resHdrNew.set('access-control-expose-headers', '*') // 设置跨域暴露头
        resHdrNew.set('access-control-allow-origin', '*') // 允许所有来源

        // 删除可能干扰代理内容的响应头
        resHdrNew.delete('content-security-policy')
        resHdrNew.delete('content-security-policy-report-only')
        resHdrNew.delete('clear-site-data')
        resHdrNew.delete('x-frame-options') // 额外删除一些可能造成问题的头部
        resHdrNew.delete('x-content-type-options')

        return new Response(res.body, {
            status,
            headers: resHdrNew,
        })
    } catch (error) {
        // console.error("Proxy fetch error:", error); // 调试日志
        return new Response(`Proxy Error: ${error.message}`, { status: 500 });
    }
}

// 伪装 Nginx 页面
async function nginx() {
    const text = `
    <!DOCTYPE html>
    <html>
    <head>
    <title>Welcome to nginx!</title>
    <style>
        body {
            width: 35em;
            margin: 0 auto;
            font-family: Tahoma, Verdana, Arial, sans-serif;
        }
    </style>
    </head>
    <body>
    <h1>Welcome to nginx!</h1>
    <p>If you see this page, the nginx web server is successfully installed and
    working. Further configuration is required.</p>

    <p>For online documentation and support please refer to
    <a href="http://nginx.org/">nginx.org</a>.<br/>
    Commercial support is available at
    <a href="http://nginx.com/">nginx.com</a>.</p>

    <p><em>Thank you for using nginx.</em></p>
    </body>
    </html>
    `
    return text;
}

// 解析环境变量中的UA字符串
async function ADD(envadd) {
    var addtext = envadd.replace(/[	 |"'\r\n]+/g, ',').replace(/,+/g, ','); // 将空格、双引号、单引号和换行符替换为逗号
    if (addtext.charAt(0) == ',') addtext = addtext.slice(1);
    if (addtext.charAt(addtext.length - 1) == ',') addtext = addtext.slice(0, addtext.length - 1);
    const add = addtext.split(',');
    return add;
}

// ====================================================================
// EdgeOne Pages Functions (Cloudflare Pages Functions 兼容) 入口
// ====================================================================

/**
 * 主要的请求处理函数 (EdgeOne Pages Functions 兼容)
 * @param {object} context - Pages Functions 的上下文对象
 * @param {Request} context.request - 原始请求对象
 * @param {object} context.env - 环境变量对象
 * @param {object} context.params - 动态路由参数 (如果使用 `[...path].js` 命名)
 * @param {function} context.waitUntil - 用于延长 Worker 生命周期
 */
export async function onRequest(context) {
    // 从 context 对象中解构出 request 和 env
    const { request, env } = context;
    const url = new URL(request.url);
    const urlObj = new URL(request.url); // 保持 urlObj 的创建方式与原始代码一致

    // console.log("Incoming request URL:", request.url); // 调试日志

    // 1. 爬虫UA屏蔽逻辑
    if (env.UA) {
        屏蔽爬虫UA = 屏蔽爬虫UA.concat(await ADD(env.UA));
    }
    const userAgentHeader = request.headers.get('User-Agent');
    const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
    if (屏蔽爬虫UA.some(fxxk => userAgent.includes(fxxk)) && 屏蔽爬虫UA.length > 0) {
        // console.log("Blocked by UA:", userAgent); // 调试日志
        return new Response(await nginx(), {
            headers: {
                'Content-Type': 'text/html; charset=UTF-8',
            },
        });
    }

    // 2. favicon.ico 处理
    if (url.pathname.toLowerCase() == '/favicon.ico') {
        const iconData = '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';
        // 将base64解码为二进制数据
        const binaryData = atob(iconData);
        const uint8Array = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
            uint8Array[i] = binaryData.charCodeAt(i);
        }

        // 返回icon图像
        return new Response(uint8Array, {
            headers: {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=86400', // 缓存一天
            },
        });
    }

    // 3. 处理通过 `?q=` 参数传递的 GitHub URL
    // 这个逻辑会优先处理 `?q=` 参数，然后执行 301 重定向
    let pathFromQuery = urlObj.searchParams.get('q');
    if (pathFromQuery) {
        // 重定向到 EdgeOne Pages 的实际 URL 结构
        // 例如：如果 Pages 域名是 `your-pages-domain.com`
        // 那么重定向到 `https://your-pages-domain.com/PREFIX/github.com/user/repo/...`
        // 注意：`urlObj.host` 是原始请求的主机名，`PREFIX` 是您定义的路由前缀
        // 这里假设 `PREFIX` 是 `/`，且您的 Pages Functions 直接处理根路径
        // 如果您的 Pages Functions 部署在 `/api/` 这样的子路径下，您需要调整 `PREFIX`
        // 例如，如果您的函数文件是 `functions/api/index.js`，并且您希望 `yourdomain.com/api/github.com/user/repo` 这样的 URL 结构
        // 那么 `PREFIX` 应该设置为 `/api/`
        return Response.redirect('https://' + urlObj.host + PREFIX + pathFromQuery, 301);
    }

    // 4. 解析目标路径
    // 对于 EdgeOne Pages Functions，`url.pathname` 是请求的路径
    // 如果你的函数文件是 `functions/index.js`，那么 `url.pathname` 就是 `/` 或 `/some/path`
    // 如果你的函数文件是 `functions/[...rest].js`，那么 `context.params.rest` 会包含 `some/path`
    // 这里我们假设 `functions/index.js` 并且 `PREFIX` 是 `/`，直接从 `url.pathname` 提取
    let targetPath = url.pathname;

    // 如果你的 PREFIX 不是 '/'，并且你希望移除它
    if (PREFIX !== '/' && targetPath.startsWith(PREFIX)) {
        targetPath = targetPath.substring(PREFIX.length);
    }
    // console.log("Extracted targetPath from pathname:", targetPath); // 调试日志

    // 确保 targetPath 是一个完整的 HTTPS URL，因为 httpHandler 期望如此
    // 例如，如果请求是 `/github.com/user/repo/file.txt`，`targetPath` 将是 `github.com/user/repo/file.txt`
    // 我们需要将其转换为 `https://github.com/user/repo/file.txt`
    if (targetPath.search(/^https?:\/\//) !== 0) {
        targetPath = 'https://' + targetPath;
    }
    // console.log("Final targetPath for processing:", targetPath); // 调试日志


    // 5. 根据正则表达式匹配并处理请求
    if (targetPath.search(exp1) === 0 || targetPath.search(exp5) === 0 || targetPath.search(exp6) === 0 || targetPath.search(exp3) === 0 || targetPath.search(exp4) === 0) {
        return httpHandler(request, targetPath);
    } else if (targetPath.search(exp2) === 0) { // blob/raw 路径
        if (Config.jsdelivr) {
            const newJsdelivrUrl = targetPath.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh');
            // console.log("Redirecting blob to jsDelivr:", newJsdelivrUrl); // 调试日志
            return Response.redirect(newJsdelivrUrl, 302);
        } else {
            targetPath = targetPath.replace('/blob/', '/raw/');
            // console.log("Converting blob to raw and handling:", targetPath); // 调试日志
            return httpHandler(request, targetPath);
        }
    } else if (targetPath.search(exp4) === 0) { // raw.githubusercontent.com 路径
        const newJsdelivrUrl = targetPath.replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, '@$1').replace(/^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/, 'https://cdn.jsdelivr.net/gh');
        // console.log("Redirecting raw.githubusercontent to jsDelivr:", newJsdelivrUrl); // 调试日志
        return Response.redirect(newJsdelivrUrl, 302);
    } else {
        // 6. 默认/Fallback 行为
        // console.log("No specific GitHub pattern matched for:", targetPath); // 调试日志

        if (env.URL302) {
            // console.log("Redirecting to env.URL302:", env.URL302); // 调试日志
            return Response.redirect(env.URL302, 302);
        } else if (env.URL) {
            if (env.URL.toLowerCase() == 'nginx') {
                // console.log("Returning Nginx fake page."); // 调试日志
                return new Response(await nginx(), {
                    headers: {
                        'Content-Type': 'text/html; charset=UTF-8',
                    },
                });
            } else {
                // console.log("Fetching from env.URL:", env.URL); // 调试日志
                return fetch(new Request(env.URL, request));
            }
        } else {
            // console.log("Returning GitHub interface."); // 调试日志
            return new Response(await githubInterface(), {
                headers: {
                    'Content-Type': 'text/html; charset=UTF-8',
                },
            });
        }
    }
}

// GitHub Interface HTML (保持不变)
async function githubInterface() {
    const html = `
		<!DOCTYPE html>
		<html lang="zh-CN">
		<head>
			<title>GitHub 文件加速</title>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<style>
				:root {
					--primary-color: #0d1117;
					--secondary-color: #161b22;
					--text-color: #f0f6fc;
					--accent-color: #58a6ff;
					--gradient-start: #24292e;
					--gradient-end: #0d1117;
					--shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
					--border-color: rgba(255, 255, 255, 0.1);
					--github-corner-bg: #f0f6fc;
					--github-corner-fg: rgb(21,26,31);
				}

				* {
					box-sizing: border-box;
					margin: 0;
					padding: 0;
				}

				body {
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
					min-height: 100vh;
					background: linear-gradient(135deg, var(--gradient-start) 0%, var(--gradient-end) 100%);
					color: var(--text-color);
					display: flex;
					justify-content: center;
					align-items: center;
					padding: 20px;
				}

				.container {
					width: 100%;
					max-width: 800px;
					padding: 40px 20px;
					text-align: center;
				}

				.title {
					font-size: 2.5rem;
					font-weight: 600;
					margin-bottom: 1.5rem;
					color: var(--text-color);
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
					letter-spacing: -0.5px;
				}

				.title .emoji {
					display: inline-block;
					color: #f1fa8c;
					margin-right: 8px;
				}

				.tips a {
					color: var(--accent-color);
					text-decoration: none;
					border-bottom: 1px dashed rgba(88, 166, 255, 0.5);
					transition: all 0.2s ease;
				}

				.tips a:hover {
					color: #a2d2ff;
					border-bottom-color: #a2d2ff;
				}

				.search-container {
					position: relative;
					max-width: 600px;
					margin: 2rem auto;
				}

				.search-input {
					width: 100%;
					height: 56px;
					padding: 0 60px 0 24px;
					font-size: 1rem;
					color: #1f2937;
					background: rgba(255, 255, 255, 0.95);
					border: 2px solid transparent;
					border-radius: 12px;
					box-shadow: var(--shadow);
					transition: all 0.3s ease;
				}

				.search-input:focus {
					border-color: var(--accent-color);
					background: white;
					outline: none;
					box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.3);
				}

				.search-button {
					position: absolute;
					right: 8px;
					top: 50%;
					transform: translateY(-50%);
					width: 44px;
					height: 44px;
					border: none;
					border-radius: 8px;
					background: var(--accent-color);
					color: white;
					cursor: pointer;
					transition: all 0.2s ease;
				}

				.search-button:hover {
					background: #4187d7;
					transform: translateY(-50%) scale(1.05);
				}

				.tips {
					margin-top: 2rem;
					color: rgba(240, 246, 252, 0.8);
					line-height: 1.6;
					text-align: left;
					padding-left: 1.8rem;
				}

				.example-title {
					color: var(--accent-color);
					margin-bottom: 1.5rem;
					font-size: 1.1rem;
					font-weight: 600;
					position: relative;
					padding-bottom: 0.8rem;
					border-bottom: 1px solid var(--border-color);
				}

				.example p {
					margin: 0.9rem 0;
					font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
					font-size: 0.95rem;
					color: rgba(240, 246, 252, 0.9);
					padding-left: 1.5rem;
					line-height: 1.4;
					word-wrap: break-word;
					word-break: break-all;
					overflow-wrap: break-word;
				}

				.example {
					margin-top: 2.5rem;
					padding: 1.8rem;
					background: rgba(255, 255, 255, 0.05);
					border-radius: 12px;
					text-align: left;
					border: 1px solid var(--border-color);
					box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
					overflow-x: auto;
				}

				.url-part {
					color: var(--accent-color);
				}

				.github-corner {
					position: fixed;
					top: 0;
					right: 0;
					z-index: 999;
				}

				.github-corner svg {
					fill: var(--github-corner-bg);
					color: var(--github-corner-fg);
					position: absolute;
					top: 0;
					border: 0;
					right: 0;
					width: 80px;
					height: 80px;
				}

				.github-corner a,
				.github-corner a:visited {
					color: var(--github-corner-fg) !important;
				}

				.github-corner a,
				.github-corner a:visited {
					color: transparent !important;
					text-decoration: none !important;
				}

				.github-corner .octo-body,
				.github-corner .octo-arm {
					fill: var(--github-corner-fg) !重要;
				}

				.github-corner:hover .octo-arm {
					animation: octocat-wave 560ms ease-in-out;
				}

				@keyframes octocat-wave {
					0%, 100% { transform: rotate(0); }
					20%, 60% { transform: rotate(-25deg); }
					40%, 80% { transform: rotate(10deg); }
				}

				@media (max-width: 640px) {
					.container {
						padding: 20px;
					}

					.title {
						font-size: 2rem;
					}

					.search-input {
						height: 50px;
						font-size: 0.9rem;
					}

					.search-button {
						width: 38px;
						height: 38px;
					}

					.example {
						padding: 1rem;
					}
					
					.example p {
						font-size: 0.85rem;
						padding-left: 0.8rem;
						margin: 0.7rem 0;
					}
					
					.example-title {
						font-size: 0.95rem;
						padding-bottom: 0.6rem;
					}
					
					.github-corner svg {
						width: 60px;
						height: 60px;
					}
				}
			</style>
		</head>
		<body>
			<a href="https://github.com/cmliu/CF-Workers-GitHub" target="_blank" class="github-corner" aria-label="View source on Github">
				<svg viewBox="0 0 250 250" aria-hidden="true">
					<path d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
					<path d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2" fill="currentColor" style="transform-origin: 130px 106px;" class="octo-arm"></path>
					<path d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z" fill="currentColor" class="octo-body"></path>
				</svg>
			</a>
			
			<div class="container">
				<h1 class="title"><span class="emoji">📦</span>GitHub 文件加速</h1>
				
				<form onsubmit="toSubmit(event)" class="search-container">
					<input 
						type="text" 
						class="search-input"
						name="q" 
						placeholder="请输入 GitHub 文件链接"
						pattern="^((https|http):\/\/)?(github\.com\/.+?\/.+?\/(?:releases|archive|blob|raw|suites)|((?:raw|gist)\.(?:githubusercontent|github)\.com))\/.+$" 
						required
					>
					<button type="submit" class="search-button">
						<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
							<path d="M13 5l7 7-7 7M5 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					</button>
				</form>

				<div class="tips">
					<p>✨ 支持带协议头(https://)或不带的GitHub链接，更多用法见<a href="https://hunsh.net/archives/23/">文档说明</a></p>
					<p>🚀 release、archive使用cf加速，文件会跳转至JsDelivr</p>
					<p>⚠️ 注意：暂不支持文件夹下载</p>
				</div>

				<div class="example">
					<div class="example-title">📃 合法输入示例：</div>
					<p>📄 分支源码：<span class="url-part">github.com/hunshcn/project/archive/master.zip</span></p>
					<p>📁 release源码：<span class="url-part">github.com/hunshcn/project/archive/v0.1.0.tar.gz</span></p>
					<p>📂 release文件：<span class="url-part">github.com/hunshcn/project/releases/download/v0.1.0/example.zip</span></p>
					<p>💾 commit文件：<span class="url-part">github.com/hunshcn/project/blob/123/filename</span></p>
					<p>🖨️ gist：<span class="url-part">gist.githubusercontent.com/cielpy/123/raw/cmd.py</span></p>
				</div>
			</div>

			<script>
				function toSubmit(e) {
					e.preventDefault();
					const input = document.getElementsByName('q')[0];
					const baseUrl = location.href.substr(0, location.href.lastIndexOf('/') + 1);
					window.open(baseUrl + input.value);
				}
			</script>
		</body>
		</html>
	`;
    return html;
}

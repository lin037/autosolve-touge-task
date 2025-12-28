// ==UserScript==
// @name         头歌自动做题
// @namespace    http://tampermonkey.net/
// @version      0.7.3
// @description  读取学习内容+代码模板，调用远程大模型返回完整代码，写入Monaco并点击运行评测，支持失败重试，通过后自动下一关（跨页面刷新），支持流式响应，通过拦截网络请求获取原始代码模板
// @author       Lin037
// @match        https://www.educoder.net/tasks/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=educoder.net
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  /**
   * ============= 可配置区 =============
   */
  const CONFIG = {
    // API 配置
    baseUrl: "https://openai.com/v1",
    // API 密钥
    apiKey: "sk-xxx",
    // 模型名称
    model: "chat-gpt",
    
    temperature: 0.2,
    maxTokens: 8192,

    // 是否使用流式响应（推荐开启,特别是对于深度思考模型）
    // 注意：某些模型可能不支持流式响应，如遇到问题请关闭
    useStream: true,

    // 是否启用深度思考模式（仅对支持的模型有效，如 GLM-4.7）
    // 注意：开启后模型会先"思考"再输出，耗时更长但质量可能更好
    enableThinking: false,
    
    // 思考预算（token 数量），仅在 enableThinking=true 时有效
    // 较小的值可以减少思考时间，推荐 512-2048
    thinkingBudget: 1024,

    // 是否输出详细日志
    verboseLog: true,

    // 最大重试次数（评测失败后重试）
    maxRetryCount: 1,

    // 轮询评测结果的超时时间（毫秒）
    pollResultTimeoutMs: 120000,

    // 轮询间隔（毫秒）
    pollIntervalMs: 2000,

    // 系统提示词
    systemPrompt: [
      "你是一个严格的代码补全助手，专门用于在线编程平台的代码填空题。",
      "",
      "## 核心规则（必须严格遵守）",
      "1. 你收到的是一个【完整的代码模板文件】，其中有多个 begin/end 或 BEGIN/END 注释标记的区域需要你补全。",
      "2. 你必须返回【整个文件的完整代码】，包括：",
      "   - package 声明（如果有）",
      "   - 所有 import 语句",
      "   - 类定义、方法签名等所有原有内容",
      "   - 在 begin-end 区域填入正确的实现代码",
      "3. 不要只返回 begin-end 区域的代码片段，必须返回完整文件。",
      "4. 不要添加任何解释、注释说明、Markdown 格式（如 ```java）。",
      "5. 不要修改 begin-end 区域以外的任何代码。",
      "6. 保持原有的缩进风格和代码格式。",
      "",
      "## 输出格式",
      "直接输出完整的源代码文件内容，从第一行（如 package xxx;）开始，到文件最后一行结束。",
      "不要有任何前缀或后缀文字。"
    ].join("\n"),

    selectors: {
      learningPanel: "div.tab-panel-body___iueV_",
      monacoViewLines: "div.view-lines.monaco-mouse-cursor-text",
      monacoTextArea: ".monaco-editor textarea.inputarea",
      runButton: 'button.btn-run___fh7pl[title="运行评测"]',
      resetCodeBtn: 'a[title="恢复初始代码"]',
      confirmBtn: 'button.ant-btn-primary span',
      // 评测通过弹窗中的"下一关"按钮
      nextLevelBtn: 'div.tc a.current',
      // 弹窗容器
      passModal: '.ant-modal-content',
    },

    waitRunButtonTimeoutMs: 60000,
    autoScroll: false,

    // 是否自动进入下一关（评测通过后）
    autoNextLevel: true,

    // 按钮位置（可拖拽后保存）
    buttonPosition: { right: 16, bottom: 16 },
  };

  const LOG_PREFIX = "[AutoSolve]";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 当前评测结果（用于监听）
  let currentEvalResult = null;
  let evalResultResolve = null;

  // localStorage 键名
  const STORAGE_KEY_AUTO_RUN = "autosolve_auto_run_state";
  const STORAGE_KEY_EXECUTION_LOCK = "autosolve_execution_lock";

  /**
   * 尝试获取执行锁
   * @param {boolean} forceAcquire - 是否强制获取锁（用于恢复执行场景）
   * @returns {boolean} 是否成功获取锁
   */
  function tryAcquireLock(forceAcquire) {
    try {
      const now = Date.now();
      let lockData = null;

      if (typeof GM_getValue === "function") {
        lockData = GM_getValue(STORAGE_KEY_EXECUTION_LOCK, null);
      } else {
        const saved = localStorage.getItem(STORAGE_KEY_EXECUTION_LOCK);
        lockData = saved ? JSON.parse(saved) : null;
      }

      // 检查是否有有效的锁
      if (lockData && lockData.timestamp) {
        const lockAge = now - lockData.timestamp;
        
        // 如果是强制获取（恢复执行场景），直接覆盖旧锁
        if (forceAcquire) {
          log("强制获取锁（恢复执行模式）");
        }
        // 如果锁超过 5 分钟，认为是过期锁，可以强制获取
        else if (lockAge >= 5 * 60 * 1000) {
          log("检测到过期的执行锁（" + Math.floor(lockAge / 1000) + " 秒），强制获取");
        }
        // 否则，锁仍然有效，拒绝获取
        else {
          warn("检测到其他执行任务正在进行中（锁存在 " + Math.floor(lockAge / 1000) + " 秒）");
          return false;
        }
      }

      // 获取锁
      const newLock = {
        timestamp: now,
        tabId: Math.random().toString(36).substring(7) // 简单的标签页标识
      };

      if (typeof GM_setValue === "function") {
        GM_setValue(STORAGE_KEY_EXECUTION_LOCK, newLock);
      } else {
        localStorage.setItem(STORAGE_KEY_EXECUTION_LOCK, JSON.stringify(newLock));
      }

      return true;
    } catch (e) {
      warn("获取执行锁失败:", e);
      return true; // 出错时允许执行
    }
  }

  /**
   * 释放执行锁
   */
  function releaseLock() {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(STORAGE_KEY_EXECUTION_LOCK, null);
      } else {
        localStorage.removeItem(STORAGE_KEY_EXECUTION_LOCK);
      }
    } catch (e) {}
  }

  /**
   * 保存自动执行状态到 localStorage
   */
  function saveAutoRunState(state) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(STORAGE_KEY_AUTO_RUN, state);
      } else {
        localStorage.setItem(STORAGE_KEY_AUTO_RUN, JSON.stringify(state));
      }
    } catch (e) {
      warn("保存自动执行状态失败:", e);
    }
  }

  /**
   * 读取自动执行状态
   */
  function getAutoRunState() {
    try {
      if (typeof GM_getValue === "function") {
        return GM_getValue(STORAGE_KEY_AUTO_RUN, null);
      } else {
        const saved = localStorage.getItem(STORAGE_KEY_AUTO_RUN);
        return saved ? JSON.parse(saved) : null;
      }
    } catch (e) {
      return null;
    }
  }

  /**
   * 清除自动执行状态
   */
  function clearAutoRunState() {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(STORAGE_KEY_AUTO_RUN, null);
      } else {
        localStorage.removeItem(STORAGE_KEY_AUTO_RUN);
      }
    } catch (e) {}
  }

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function error(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  function verboseLog(label, content) {
    if (!CONFIG.verboseLog) return;
    console.group(LOG_PREFIX + " [VERBOSE] " + label);
    console.log(content);
    console.groupEnd();
  }

  function getPageWindow() {
    if (typeof unsafeWindow !== "undefined") {
      return unsafeWindow;
    }
    return window;
  }

  // ============= 拦截评测结果请求 =============
  function setupRequestInterceptor() {
    const pageWin = getPageWindow();

    // 拦截 fetch
    const originalFetch = pageWin.fetch;
    pageWin.fetch = function(url, options) {
      return originalFetch.apply(this, arguments).then(function(response) {
        // 检查是否是评测结果请求
        if (typeof url === "string" && url.includes("/game_status.json")) {
          // 克隆响应以便读取
          response.clone().json().then(function(data) {
            handleGameStatusResponse(data);
          }).catch(function() {});
        }
        return response;
      });
    };

    // 拦截 XMLHttpRequest
    const originalXHROpen = pageWin.XMLHttpRequest.prototype.open;
    const originalXHRSend = pageWin.XMLHttpRequest.prototype.send;

    pageWin.XMLHttpRequest.prototype.open = function(method, url) {
      this._autosolve_url = url;
      return originalXHROpen.apply(this, arguments);
    };

    pageWin.XMLHttpRequest.prototype.send = function() {
      const xhr = this;
      const url = xhr._autosolve_url;

      if (typeof url === "string" && url.includes("/game_status.json")) {
        xhr.addEventListener("load", function() {
          try {
            const data = JSON.parse(xhr.responseText);
            handleGameStatusResponse(data);
          } catch (e) {}
        });
      }

      return originalXHRSend.apply(this, arguments);
    };

    log("已设置请求拦截器");
  }

  function handleGameStatusResponse(data) {
    // 忽略 running_code_status 类型的响应（服务启动中）
    if (data && typeof data.running_code_status !== "undefined") {
      log("评测服务状态:", data.running_code_message || data.running_code_status);
      return;
    }

    // 这是最终评测结果
    if (data && typeof data.status !== "undefined") {
      log("收到评测结果:", {
        status: data.status,
        sets_error_count: data.sets_error_count,
        test_sets_count: data.test_sets_count
      });

      currentEvalResult = data;

      // 如果有等待的 Promise，resolve 它
      if (evalResultResolve) {
        evalResultResolve(data);
        evalResultResolve = null;
      }
    }
  }

  // 等待评测结果
  function waitForEvalResult() {
    return new Promise(function(resolve, reject) {
      currentEvalResult = null;
      evalResultResolve = resolve;

      // 超时处理
      setTimeout(function() {
        if (evalResultResolve) {
          evalResultResolve = null;
          reject(new Error("等待评测结果超时"));
        }
      }, CONFIG.pollResultTimeoutMs);
    });
  }

  // ============= Monaco 相关 =============
  function findMonacoInstance() {
    const pageWin = getPageWindow();

    if (pageWin.monaco && pageWin.monaco.editor && pageWin.monaco.editor.getModels) {
      return pageWin.monaco;
    }

    if (typeof pageWin.require === "function") {
      try {
        const monaco = pageWin.require("monaco-editor");
        if (monaco && monaco.editor && monaco.editor.getModels) {
          return monaco;
        }
      } catch (e) {}
      try {
        const monaco = pageWin.require("vs/editor/editor.main");
        if (monaco && monaco.editor && monaco.editor.getModels) {
          return monaco;
        }
      } catch (e) {}
    }

    var keys = Object.keys(pageWin);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      try {
        var obj = pageWin[key];
        if (obj && obj.editor && typeof obj.editor.getModels === "function") {
          return obj;
        }
      } catch (e) {}
    }

    return null;
  }

  function normalizeBaseUrl(baseUrl) {
    const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    return trimmed;
  }

  function buildChatCompletionsUrl() {
    const base = normalizeBaseUrl(CONFIG.baseUrl);
    if (base.endsWith("/v1")) return base + "/chat/completions";
    return base + "/v1/chat/completions";
  }

  function ensureConfig() {
    if (!normalizeBaseUrl(CONFIG.baseUrl)) {
      throw new Error("CONFIG.baseUrl 未配置");
    }
    if (!String(CONFIG.apiKey || "").trim() || CONFIG.apiKey === "YOUR_API_KEY_HERE") {
      throw new Error("CONFIG.apiKey 未配置");
    }
    if (!String(CONFIG.model || "").trim()) {
      throw new Error("CONFIG.model 未配置");
    }
  }

  function htmlToPlainTextAndImages(containerEl) {
    if (!containerEl) {
      return { text: "", images: [] };
    }

    const clone = containerEl.cloneNode(true);
    const images = [];
    const imgs = clone.querySelectorAll("img");
    imgs.forEach(function(img) {
      const url = img.getAttribute("src") || img.getAttribute("data-src") || img.currentSrc || "";
      const clean = String(url || "").trim();
      if (clean) images.push(clean);
      const placeholder = clean ? "[Image] " + clean : "[Image]";
      const span = document.createElement("span");
      span.textContent = placeholder;
      img.replaceWith(span);
    });

    clone.querySelectorAll("br").forEach(function(br) { br.replaceWith("\n"); });
    clone.querySelectorAll("li").forEach(function(li) {
      const prefix = document.createElement("span");
      prefix.textContent = "- ";
      li.insertBefore(prefix, li.firstChild);
      li.appendChild(document.createTextNode("\n"));
    });
    clone.querySelectorAll("p,h1,h2,h3,h4,h5,h6,section,article,div").forEach(function(el) {
      const txt = (el.textContent || "").trim();
      if (txt) el.appendChild(document.createTextNode("\n"));
    });
    clone.querySelectorAll("pre,code").forEach(function(el) {
      el.insertBefore(document.createTextNode("\n"), el.firstChild);
      el.appendChild(document.createTextNode("\n"));
    });

    let text = clone.textContent || "";
    text = text
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const seen = new Set();
    const uniqImages = [];
    for (var i = 0; i < images.length; i++) {
      var u = images[i];
      if (!seen.has(u)) {
        seen.add(u);
        uniqImages.push(u);
      }
    }

    return { text: text, images: uniqImages };
  }

  function getLearningContent() {
    const container = document.querySelector(CONFIG.selectors.learningPanel);
    if (!container) {
      throw new Error("找不到学习内容容器: " + CONFIG.selectors.learningPanel);
    }
    if (CONFIG.autoScroll) container.scrollIntoView({ behavior: "smooth", block: "start" });
    const result = htmlToPlainTextAndImages(container);
    return { text: result.text, images: result.images };
  }

  function getMonacoCodeByAPI() {
    const monaco = findMonacoInstance();
    if (!monaco) {
      return null;
    }

    const models = monaco.editor.getModels();
    if (!Array.isArray(models) || models.length === 0) {
      return null;
    }

    // 选择第一个有内容的 model
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      if (model && model.getValue) {
        const value = model.getValue();
        if (typeof value === "string" && value.trim()) {
          return { code: value, model: model, monaco: monaco };
        }
      }
    }

    return null;
  }

  function getMonacoCodeByDOM() {
    const view = document.querySelector(CONFIG.selectors.monacoViewLines);
    if (!view) return null;

    const lines = view.querySelectorAll(".view-line");
    let codeLines = [];

    lines.forEach(function(line) {
      let lineText = "";
      const spans = line.querySelectorAll("span");
      spans.forEach(function(span) {
        lineText += span.textContent || "";
      });
      if (!lineText && line.textContent) {
        lineText = line.textContent;
      }
      codeLines.push(lineText);
    });

    let text = codeLines.join("\n");
    text = text.replace(/\u00a0/g, " ").trim();

    return { code: text, model: null, domOnly: true };
  }

  function getCurrentCodeTemplate() {
    const byApi = getMonacoCodeByAPI();
    if (byApi && byApi.code) {
      return { code: byApi.code, monacoModel: byApi.model, monaco: byApi.monaco, source: "monaco-api" };
    }

    const byDom = getMonacoCodeByDOM();
    if (byDom && byDom.code) {
      warn("未拿到 Monaco API，改为 DOM 兜底读取");
      return { code: byDom.code, monacoModel: null, monaco: null, source: "monaco-dom" };
    }

    throw new Error("找不到 Monaco 代码区域");
  }

  function setMonacoCodeByAPI(codeText, monacoRef, modelRef) {
    var monaco = monacoRef || findMonacoInstance();
    if (!monaco) return false;

    var model = modelRef;
    if (!model) {
      const models = monaco.editor.getModels();
      if (!Array.isArray(models) || models.length === 0) return false;

      // 选择第一个有内容的 model
      for (let i = 0; i < models.length; i++) {
        const m = models[i];
        if (m && m.getValue && m.setValue) {
          model = m;
          break;
        }
      }
    }

    if (!model || !model.setValue) return false;

    model.setValue(codeText);
    return true;
  }

  function setMonacoCodeByDOM(codeText) {
    const ta = document.querySelector(CONFIG.selectors.monacoTextArea);
    if (!ta) return false;

    ta.focus();
    document.execCommand("selectAll");
    const ok = document.execCommand("insertText", false, codeText);
    if (ok) return true;

    try {
      ta.value = codeText;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function setEditorCode(codeText, monacoRef, modelRef) {
    if (typeof codeText !== "string" || !codeText.trim()) {
      throw new Error("代码为空，拒绝写入编辑器");
    }

    if (setMonacoCodeByAPI(codeText, monacoRef, modelRef)) {
      log("已通过 Monaco API 写入代码");
      return;
    }

    warn("Monaco API 写入失败，尝试 DOM 方式写入");
    const ok = setMonacoCodeByDOM(codeText);
    if (!ok) {
      throw new Error("写入编辑器失败");
    }
    log("已通过 DOM 方式写入代码");
  }

  // ============= 拦截网络请求获取原始代码模板 =============
  // 用于存储从网络请求中捕获的原始代码模板
  let capturedOriginalCode = null;

  // 设置 XHR 拦截器来捕获 reset_original_code.json 响应
  function setupCodeInterceptor() {
    // 必须使用 unsafeWindow 来拦截页面真实的网络请求
    // 否则油猴脚本只能拦截沙盒环境中的请求
    const targetWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    const originalXHROpen = targetWindow.XMLHttpRequest.prototype.open;
    const originalXHRSend = targetWindow.XMLHttpRequest.prototype.send;

    targetWindow.XMLHttpRequest.prototype.open = function(method, url) {
      this._interceptUrl = url;
      return originalXHROpen.apply(this, arguments);
    };

    targetWindow.XMLHttpRequest.prototype.send = function() {
      const xhr = this;
      const url = xhr._interceptUrl || "";

      // 检查是否是重置代码的请求
      if (url.includes("reset_original_code.json")) {
        log("检测到 reset_original_code 请求 (XHR):", url);
        xhr.addEventListener("load", function() {
          try {
            log("reset_original_code 响应状态:", xhr.status);
            if (xhr.status === 200 && xhr.responseText) {
              const data = JSON.parse(xhr.responseText);
              log("reset_original_code 响应数据 keys:", Object.keys(data));
              // 响应格式通常是 { content: "代码内容" } 或类似结构
              if (data.content) {
                capturedOriginalCode = data.content;
                log("已从网络请求捕获原始代码模板，长度:", capturedOriginalCode.length);
              } else if (data.code) {
                capturedOriginalCode = data.code;
                log("已从网络请求捕获原始代码模板 (code字段)，长度:", capturedOriginalCode.length);
              } else if (typeof data === "string") {
                capturedOriginalCode = data;
                log("已从网络请求捕获原始代码模板 (字符串)，长度:", capturedOriginalCode.length);
              } else {
                // 尝试找到包含代码的字段
                for (const key in data) {
                  if (typeof data[key] === "string" && data[key].length > 50) {
                    capturedOriginalCode = data[key];
                    log("已从网络请求捕获原始代码模板 (" + key + "字段)，长度:", capturedOriginalCode.length);
                    break;
                  }
                }
                if (!capturedOriginalCode) {
                  warn("未能从响应中找到代码字段，响应内容:", JSON.stringify(data).substring(0, 500));
                }
              }
            }
          } catch (e) {
            warn("解析 reset_original_code 响应失败:", e);
          }
        });
      }

      return originalXHRSend.apply(this, arguments);
    };

    log("XHR 拦截器已设置 (使用 " + (typeof unsafeWindow !== "undefined" ? "unsafeWindow" : "window") + ")");
  }

  // 同时拦截 fetch 请求
  function setupFetchInterceptor() {
    // 必须使用 unsafeWindow 来拦截页面真实的 fetch 请求
    const targetWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const originalFetch = targetWindow.fetch;

    targetWindow.fetch = function(input, init) {
      const url = typeof input === "string" ? input : (input && input.url ? input.url : "");

      // 检查是否是重置代码的请求
      if (url && url.includes("reset_original_code.json")) {
        log("检测到 reset_original_code 请求 (fetch):", url);
      }

      return originalFetch.apply(this, arguments).then(response => {
        // 检查是否是重置代码的请求
        if (url && url.includes("reset_original_code.json")) {
          log("reset_original_code fetch 响应状态:", response.status);
          // 克隆响应以便读取
          const clonedResponse = response.clone();
          clonedResponse.json().then(data => {
            try {
              log("reset_original_code fetch 响应数据 keys:", Object.keys(data));
              if (data.content) {
                capturedOriginalCode = data.content;
                log("已从 fetch 请求捕获原始代码模板，长度:", capturedOriginalCode.length);
              } else if (data.code) {
                capturedOriginalCode = data.code;
                log("已从 fetch 请求捕获原始代码模板 (code字段)，长度:", capturedOriginalCode.length);
              } else if (typeof data === "string") {
                capturedOriginalCode = data;
                log("已从 fetch 请求捕获原始代码模板 (字符串)，长度:", capturedOriginalCode.length);
              } else {
                for (const key in data) {
                  if (typeof data[key] === "string" && data[key].length > 50) {
                    capturedOriginalCode = data[key];
                    log("已从 fetch 请求捕获原始代码模板 (" + key + "字段)，长度:", capturedOriginalCode.length);
                    break;
                  }
                }
                if (!capturedOriginalCode) {
                  warn("未能从 fetch 响应中找到代码字段，响应内容:", JSON.stringify(data).substring(0, 500));
                }
              }
            } catch (e) {
              warn("解析 fetch reset_original_code 响应失败:", e);
            }
          }).catch((e) => {
            warn("读取 fetch 响应 JSON 失败:", e);
          });
        }
        return response;
      });
    };

    log("Fetch 拦截器已设置 (使用 " + (typeof unsafeWindow !== "undefined" ? "unsafeWindow" : "window") + ")");
  }

  // ============= 重置代码为模板 =============
  async function resetCodeToTemplate() {
    log("重置代码为模板...");

    // 清空之前捕获的代码
    capturedOriginalCode = null;

    // 点击"恢复初始代码"按钮
    const resetBtn = document.querySelector(CONFIG.selectors.resetCodeBtn);
    if (!resetBtn) {
      warn("未找到恢复初始代码按钮，跳过重置");
      return { success: false, code: null };
    }

    resetBtn.click();
    log("已点击恢复初始代码按钮");

    // 等待弹窗出现
    await sleep(500);

    // 点击确定按钮
    const confirmBtns = document.querySelectorAll("button.ant-btn-primary");
    let clicked = false;
    for (var i = 0; i < confirmBtns.length; i++) {
      const btn = confirmBtns[i];
      const text = btn.textContent || "";
      if (text.includes("确") && text.includes("定")) {
        btn.click();
        clicked = true;
        log("已点击确定按钮");
        break;
      }
    }

    if (!clicked) {
      // 尝试另一种方式
      const confirmBtn = document.querySelector(".ant-modal-confirm-btns .ant-btn-primary");
      if (confirmBtn) {
        confirmBtn.click();
        clicked = true;
        log("已点击确定按钮 (备用选择器)");
      }
    }

    if (!clicked) {
      warn("未找到确定按钮");
      const closeBtn = document.querySelector(".ant-modal-close");
      if (closeBtn) closeBtn.click();
      return { success: false, code: null };
    }

    // 等待网络请求完成并捕获响应
    log("等待网络请求返回原始代码模板...");
    const maxWaitTime = 10000; // 最多等待 10 秒
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      if (capturedOriginalCode) {
        log("成功获取原始代码模板！");
        return { success: true, code: capturedOriginalCode };
      }
      await sleep(200);
    }

    warn("未能从网络请求捕获原始代码模板，将回退到从编辑器读取");
    // 额外等待一下让编辑器更新
    await sleep(1000);
    return { success: true, code: null };
  }

  // ============= 评测按钮 =============
  async function waitForRunButtonEnabled() {
    const start = Date.now();
    while (Date.now() - start < CONFIG.waitRunButtonTimeoutMs) {
      const btn = document.querySelector(CONFIG.selectors.runButton);
      if (btn && !btn.disabled) return btn;
      await sleep(300);
    }
    throw new Error("等待运行评测按钮可点击超时");
  }

  async function clickRunEvaluate() {
    const btn = await waitForRunButtonEnabled();
    btn.click();
    log("已点击运行评测按钮");
  }

  // ============= 下一关相关 =============
  /**
   * 检查评测结果是否表示通过
   * status === 2 表示通过
   */
  function isEvalPassed(evalResult) {
    if (!evalResult) return false;
    // status === 2 表示评测通过
    return evalResult.status === 2 || evalResult.sets_error_count === 0;
  }

  /**
   * 检查是否有下一关
   * 通过 evalResult.next_game 判断
   */
  function hasNextLevel(evalResult) {
    return evalResult && evalResult.next_game && typeof evalResult.next_game === "string";
  }

  /**
   * 等待弹窗出现并点击"下一关"按钮
   */
  async function clickNextLevelButton() {
    log("等待下一关弹窗出现...");

    // 等待弹窗出现（最多等待 10 秒，因为可能有动画）
    const start = Date.now();
    let nextBtn = null;
    let attemptCount = 0;

    while (Date.now() - start < 10000) {
      attemptCount++;
      
      // 查找"下一关"按钮
      // 选择器: div.tc a.current，文本包含"下一关"
      const candidates = document.querySelectorAll("div.tc a.current, .ant-modal a.current, a.current");
      
      if (CONFIG.verboseLog && attemptCount % 5 === 0) {
        log("查找下一关按钮中... 尝试次数:", attemptCount, "找到候选按钮:", candidates.length);
      }
      
      for (let i = 0; i < candidates.length; i++) {
        const btn = candidates[i];
        const text = (btn.textContent || "").trim();
        if (text.includes("下一关") || text.includes("下一步")) {
          nextBtn = btn;
          log("找到下一关按钮，文本:", text);
          break;
        }
      }

      if (nextBtn) break;
      await sleep(300);
    }

    if (!nextBtn) {
      warn("未找到下一关按钮，尝试次数:", attemptCount);
      // 输出当前所有的 a.current 按钮文本，便于调试
      const allCurrentLinks = document.querySelectorAll("a.current");
      if (allCurrentLinks.length > 0) {
        warn("当前页面的 a.current 按钮:", Array.from(allCurrentLinks).map(function(a) {
          return a.textContent.trim();
        }));
      }
      return false;
    }

    log("找到下一关按钮，准备点击");
    nextBtn.click();
    log("已点击下一关按钮");

    // 等待页面跳转/加载
    await sleep(2000);

    return true;
  }

  /**
   * 等待页面加载完成（Monaco 编辑器就绪）
   */
  async function waitForPageReady() {
    log("等待页面加载完成...");
    const start = Date.now();
    const timeout = 30000;

    while (Date.now() - start < timeout) {
      // 检查 Monaco 是否就绪
      const monaco = findMonacoInstance();
      if (monaco) {
        const models = monaco.editor.getModels();
        if (models && models.length > 0) {
          log("页面加载完成，Monaco 已就绪");
          return true;
        }
      }

      // 检查学习内容是否加载
      const learningPanel = document.querySelector(CONFIG.selectors.learningPanel);
      if (learningPanel && learningPanel.textContent && learningPanel.textContent.trim().length > 50) {
        // 再等一下让 Monaco 加载
        await sleep(1000);
        continue;
      }

      await sleep(500);
    }

    warn("等待页面加载超时");
    return false;
  }

  // ============= LLM 调用 =============

  /**
   * 从 LLM 响应中提取纯净的代码内容
   * 
   * 处理策略（按优先级）：
   * 1. 忽略 reasoning_content，只处理 content
   * 2. 移除 <think>...</think> 或 </think> 之前的所有内容
   * 3. 提取代码块内容，如果有多个代码块，取最后一个
   * 4. 清理代码块标记（```language）
   * 
   * @param {string} text - 原始文本
   * @returns {string} 清理后的纯代码
   */
  function stripCodeFencesIfAny(text) {
    var s = String(text || "").trim();

    if (!s) return s;

    // 调试：输出原始内容
    if (CONFIG.verboseLog) {
      verboseLog("stripCodeFences 原始内容（前500字符）", s.substring(0, 500));
    }

    // ========== 第一步：处理 think 标签 ==========
    // 策略：如果存在 </think> 闭合标签，移除它及其之前的所有内容
    
    // 查找最后一个 </think> 或 </thinking> 标签的位置
    const thinkCloseRegex = /<\/think(?:ing)?>/gi;
    let lastThinkCloseIndex = -1;
    let match;
    
    while ((match = thinkCloseRegex.exec(s)) !== null) {
      lastThinkCloseIndex = match.index + match[0].length;
    }
    
    if (lastThinkCloseIndex > 0) {
      // 移除 </think> 及其之前的所有内容
      s = s.substring(lastThinkCloseIndex).trim();
      if (CONFIG.verboseLog) {
        log("移除 think 标签，剩余内容长度:", s.length);
      }
    }

    // 处理自闭合标签 <think/> 或 <think />
    s = s.replace(/<think(?:ing)?\s*\/>/gi, "").trim();

    // ========== 第二步：提取代码块 ==========
    // 匹配所有 ```language\n...\n``` 格式的代码块
    // 支持：```java, ```python, ```, ```plaintext 等
    const codeBlockPattern = /```[\w-]*\s*\n([\s\S]*?)\n\s*```/g;
    const codeBlocks = [];
    
    while ((match = codeBlockPattern.exec(s)) !== null) {
      if (match[1] && match[1].trim()) {
        codeBlocks.push(match[1].trim());
      }
    }

    // 如果找到代码块，取最后一个（通常最后一个是最终答案）
    if (codeBlocks.length > 0) {
      const finalCode = codeBlocks[codeBlocks.length - 1];
      if (CONFIG.verboseLog) {
        log("找到", codeBlocks.length, "个代码块，使用最后一个，长度:", finalCode.length);
      }
      return finalCode;
    }

    // ========== 第三步：兜底处理 - 更宽松的代码块匹配 ==========
    
    // 尝试匹配 ```...``` 格式（不要求换行）
    const looseBlockMatch = s.match(/```[\w-]*\s*([\s\S]+?)\s*```/);
    if (looseBlockMatch && looseBlockMatch[1]) {
      let code = looseBlockMatch[1].trim();
      // 如果开头是语言标记后紧跟换行，去掉第一行
      if (/^[\w-]+\s*\n/.test(code)) {
        code = code.replace(/^[\w-]+\s*\n/, "").trim();
      }
      if (code) {
        if (CONFIG.verboseLog) {
          log("使用宽松匹配的代码块，长度:", code.length);
        }
        return code;
      }
    }

    // 尝试移除开头的 ``` 标记（整个内容被代码块包裹但格式不标准）
    if (s.startsWith("```")) {
      // 移除开头的 ```language 或 ```
      let cleaned = s.replace(/^```[\w-]*\s*\n?/, "");
      // 移除结尾的 ```
      cleaned = cleaned.replace(/\n?\s*```\s*$/, "");
      if (cleaned.trim()) {
        if (CONFIG.verboseLog) {
          log("移除首尾代码块标记，长度:", cleaned.trim().length);
        }
        return cleaned.trim();
      }
    }

    // ========== 第四步：最终兜底 ==========
    // 如果内容看起来像代码（包含常见代码特征），直接返回
    // 否则可能是纯文本解释，需要警告
    const codeIndicators = [
      /^package\s+\w+/m,           // Java package
      /^import\s+/m,               // import 语句
      /^#include\s*</m,            // C/C++ include
      /^def\s+\w+\s*\(/m,          // Python 函数
      /^class\s+\w+/m,             // 类定义
      /^public\s+(class|interface)/m, // Java 类
      /^function\s+\w+/m,          // JavaScript 函数
      /^\s*\/\//m,                 // 注释
      /^\s*\/\*/m,                 // 块注释
      /^#!\//m,                    // Shebang
    ];
    
    const looksLikeCode = codeIndicators.some(function(pattern) {
      return pattern.test(s);
    });

    if (looksLikeCode) {
      if (CONFIG.verboseLog) {
        log("内容看起来像代码，直接返回，长度:", s.length);
      }
      return s;
    }

    // 警告：可能返回的不是代码
    warn("警告：未找到代码块，且内容不像代码，可能解析失败！");
    warn("内容前200字符:", s.substring(0, 200));
    
    return s;
  }

  /**
   * 解析 SSE 格式的响应文本，提取所有 content
   * @param {string} text - SSE 格式的响应文本
   * @returns {object} { content: string, chunkCount: number }
   */
  function parseSSEResponse(text) {
    const lines = text.split("\n");
    let parsedContent = "";
    let chunkCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("data: ")) {
        const jsonStr = line.substring(6);

        if (jsonStr === "[DONE]") {
          continue;
        }

        try {
          const chunk = JSON.parse(jsonStr);
          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;

          if (delta && delta.content) {
            parsedContent += delta.content;
            chunkCount++;
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }

    return { content: parsedContent, chunkCount: chunkCount };
  }

  /**
   * 使用原生 fetch API 发送流式请求（推荐方式）
   * @param {string} url - API 端点
   * @param {object} payload - 请求负载
   * @returns {Promise<string>} 完整的响应内容
   */
  async function fetchStream(url, payload) {
    const streamPayload = Object.assign({}, payload, { stream: true });
    const body = JSON.stringify(streamPayload);

    log("使用 fetch 流式请求 URL:", url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + CONFIG.apiKey,
      },
      body: body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error("API 返回错误 " + response.status + ": " + errorText.slice(0, 500));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let fullContent = "";
    let buffer = ""; // 用于处理跨 chunk 的不完整行
    let tokenCount = 0;
    let thinkingTokenCount = 0; // 思考 token 计数（不计入最终内容）

    log("开始读取流式响应...");

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      // 解码并追加到缓冲区
      buffer += decoder.decode(value, { stream: true });

      // 按行处理
      const lines = buffer.split("\n");
      // 最后一行可能不完整，保留到下次处理
      buffer = lines.pop() || "";

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith("data: ")) {
          const jsonStr = line.substring(6);

          if (jsonStr === "[DONE]") {
            continue;
          }

          try {
            const chunk = JSON.parse(jsonStr);
            const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;

            if (delta) {
              // 统计 reasoning_content（思考内容）- 仅统计，不收集
              if (delta.reasoning_content) {
                thinkingTokenCount++;
                if (CONFIG.verboseLog) {
                  log("思考中...");
                }
                // 不要 continue，因为同一个 delta 可能同时有 content
              }

              // 只收集 content 字段
              if (delta.content) {
                fullContent += delta.content;
                tokenCount++;
                if (CONFIG.verboseLog) {
                  log("流式响应 token");
                }
              }
            }
          } catch (e) {
            // 忽略解析错误（可能是不完整的 chunk）
          }
        }
      }
    }

    // 处理缓冲区中剩余的内容
    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith("data: ") && line.substring(6) !== "[DONE]") {
        try {
          const chunk = JSON.parse(line.substring(6));
          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (delta && delta.content && !delta.reasoning_content) {
            fullContent += delta.content;
            tokenCount++;
          }
        } catch (e) {
          // 忽略
        }
      }
    }

    // 输出统计信息
    if (thinkingTokenCount > 0) {
      log("流式响应完成，思考:", thinkingTokenCount, "个 token，输出:", tokenCount, "个 token，总长度:", fullContent.length, "字符");
    } else {
      log("流式响应完成，共", tokenCount, "个 token，总长度:", fullContent.length, "字符");
    }
    return fullContent;
  }

  /**
   * 发送流式请求到 LLM API
   * 优先使用 fetch API（支持真正的流式），GM_xmlhttpRequest 作为备选
   * @param {string} url - API 端点
   * @param {object} payload - 请求负载
   * @returns {Promise<string>} 完整的响应内容
   */
  function gmRequestJsonStream(url, payload) {
    // 优先尝试使用 fetch API（支持真正的流式响应）
    // 注意：fetch 在油猴脚本中可能受到 CORS 限制，需要 @connect 声明
    return fetchStream(url, payload).catch(function(fetchError) {
      warn("fetch 流式请求失败，尝试使用 GM_xmlhttpRequest:", fetchError.message);

      // 回退到 GM_xmlhttpRequest
      return gmRequestJsonStreamFallback(url, payload);
    });
  }

  /**
   * 使用 GM_xmlhttpRequest 发送流式请求（备选方案）
   * 注意：GM_xmlhttpRequest 的流式支持有限，可能无法实时获取数据
   * @param {string} url - API 端点
   * @param {object} payload - 请求负载
   * @returns {Promise<string>} 完整的响应内容
   */
  function gmRequestJsonStreamFallback(url, payload) {
    const streamPayload = Object.assign({}, payload, { stream: true });
    const body = JSON.stringify(streamPayload);
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.apiKey,
    };

    return new Promise(function(resolve, reject) {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest 不可用"));
        return;
      }

      log("使用 GM_xmlhttpRequest 流式请求 URL:", url);

      let fullContent = "";
      let lastProgressTime = Date.now();
      let lastProcessedLength = 0;
      let tokenCount = 0;
      const progressTimeout = 180000; // 3分钟无数据则超时

      const timeoutChecker = setInterval(function() {
        const now = Date.now();
        if (now - lastProgressTime > progressTimeout) {
          clearInterval(timeoutChecker);
          if (fullContent) {
            log("流式响应超时，但已接收部分内容，共", tokenCount, "个 token");
            resolve(fullContent);
          } else {
            reject(new Error("流式响应超时（180秒无数据）"));
          }
        }
      }, 5000);

      GM_xmlhttpRequest({
        method: "POST",
        url: url,
        headers: headers,
        data: body,
        timeout: 600000,
        responseType: "text", // 确保以文本形式接收
        onreadystatechange: function(resp) {
          // 尝试在 readyState 变化时读取数据
          if (resp.readyState === 3 && resp.responseText) {
            lastProgressTime = Date.now();
            const text = resp.responseText;

            if (text.length > lastProcessedLength) {
              const newText = text.substring(lastProcessedLength);
              lastProcessedLength = text.length;

              // 解析新增的 SSE 数据
              const lines = newText.split("\n");
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith("data: ")) {
                  const jsonStr = line.substring(6);
                  if (jsonStr === "[DONE]") continue;

                  try {
                    const chunk = JSON.parse(jsonStr);
                    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
                    if (delta && delta.content) {
                      fullContent += delta.content;
                      tokenCount++;
                      if (CONFIG.verboseLog) {
                        log("流式响应 token");
                      }
                    }
                  } catch (e) {
                    // 忽略解析错误
                  }
                }
              }
            }
          }
        },
        onprogress: function(resp) {
          lastProgressTime = Date.now();

          if (!resp || typeof resp.responseText !== "string") return;

          const text = resp.responseText;
          if (text.length <= lastProcessedLength) return;

          const newText = text.substring(lastProcessedLength);
          lastProcessedLength = text.length;

          // 解析 SSE 格式
          const lines = newText.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith("data: ")) {
              const jsonStr = line.substring(6);
              if (jsonStr === "[DONE]") {
                continue;
              }

              try {
                const chunk = JSON.parse(jsonStr);
                const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
                if (delta && delta.content) {
                  fullContent += delta.content;
                  tokenCount++;
                  if (CONFIG.verboseLog) {
                    log("流式响应 token");
                  }
                }
              } catch (e) {
                // 忽略解析错误
              }
            }
          }
        },
        onload: function(resp) {
          clearInterval(timeoutChecker);

          if (resp.status >= 200 && resp.status < 300) {
            // 如果已经通过流式方式获取到内容
            if (fullContent) {
              log("流式响应完成，共", tokenCount, "个 token，总长度:", fullContent.length, "字符");
              resolve(fullContent);
              return;
            }

            // 在 onload 中解析完整的 SSE 响应
            const text = resp.responseText;

            if (text && text.includes("data: ")) {
              log("在 onload 中解析 SSE 响应...");
              const result = parseSSEResponse(text);

              if (result.content) {
                log("SSE 解析完成，共", result.chunkCount, "个 token，总长度:", result.content.length, "字符");
                resolve(result.content);
                return;
              }
            }

            // 尝试作为普通 JSON 响应解析
            try {
              const json = JSON.parse(text);
              const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
              if (content) {
                log("API 返回非流式响应，长度:", content.length, "字符");
                resolve(content);
              } else {
                reject(new Error("响应为空"));
              }
            } catch (e) {
              reject(new Error("无法解析响应: " + String(e)));
            }
          } else {
            error("请求返回错误状态:", resp.status);
            try {
              const json = JSON.parse(resp.responseText);
              reject(new Error("API 返回错误 " + resp.status + ": " + JSON.stringify(json).slice(0, 500)));
            } catch (e) {
              reject(new Error("API 返回错误 " + resp.status));
            }
          }
        },
        onerror: function(e) {
          clearInterval(timeoutChecker);
          error("请求网络错误:", e);
          reject(new Error("请求失败: " + JSON.stringify(e)));
        },
        ontimeout: function() {
          clearInterval(timeoutChecker);
          if (fullContent) {
            log("请求超时，但已接收部分内容，共", tokenCount, "个 token");
            resolve(fullContent);
          } else {
            reject(new Error("请求超时"));
          }
        },
      });
    });
  }

  /**
   * 发送非流式请求（保留作为备用）
   */
  function gmRequestJson(url, payload) {
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.apiKey
    };

    log("非流式请求 URL:", url);
    log("非流式请求 model:", payload.model);

    return new Promise(function(resolve, reject) {
      if (typeof GM_xmlhttpRequest === "function") {
        const startTime = Date.now();
        
        GM_xmlhttpRequest({
          method: "POST",
          url: url,
          headers: headers,
          data: body,
          timeout: 600000,  // 增加到 10 分钟（深度思考模型需要更长时间）
          onload: function(resp) {
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            log("请求完成，耗时:", duration, "秒");
            
            try {
              const json = JSON.parse(resp.responseText);
              if (resp.status >= 200 && resp.status < 300) {
                log("API 返回成功，状态码:", resp.status);
                resolve(json);
              } else {
                reject(new Error("API 返回错误 " + resp.status + ": " + JSON.stringify(json).slice(0, 500)));
              }
            } catch (e) {
              reject(new Error("解析响应 JSON 失败: " + String(e)));
            }
          },
          onerror: function(e) {
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            error("请求失败，耗时:", duration, "秒");
            reject(new Error("请求失败: " + JSON.stringify(e)));
          },
          ontimeout: function() {
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            error("请求超时，耗时:", duration, "秒");
            reject(new Error("请求超时（超过 10 分钟）"));
          }
        });
        return;
      }

      reject(new Error("GM_xmlhttpRequest 不可用"));
    });
  }

  // 首次调用 Agent（带代码模板）
  async function callAgentFirstTime(params) {
    const learningText = params.learningText;
    const imageUrls = params.imageUrls;
    const codeTemplate = params.codeTemplate;

    const url = buildChatCompletionsUrl();

    const userContentParts = [
      "## 任务描述",
      "请根据下面的【学习内容】完成代码模板中 begin-end 区域的代码补全。",
      "",
      "## 学习内容",
      learningText || "(空)",
      ""
    ];

    if (imageUrls && imageUrls.length > 0) {
      userContentParts.push("## 相关图片");
      imageUrls.forEach(function(u) {
        userContentParts.push("- " + u);
      });
      userContentParts.push("");
    }

    userContentParts.push("## 当前代码模板（需要你补全 begin-end 区域）");
    userContentParts.push("```");
    userContentParts.push(codeTemplate || "(空)");
    userContentParts.push("```");
    userContentParts.push("");
    userContentParts.push("## 输出要求");
    userContentParts.push("请输出补全后的【完整代码文件】，从 package 声明开始到文件结束。");

    const userContent = userContentParts.join("\n");

    verboseLog("System Prompt", CONFIG.systemPrompt);
    verboseLog("User Prompt (首次)", userContent);

    const payload = {
      model: CONFIG.model,
      temperature: CONFIG.temperature,
      max_tokens: CONFIG.maxTokens,
      messages: [
        { role: "system", content: CONFIG.systemPrompt },
        { role: "user", content: userContent }
      ],
      // 深度思考模式配置
      enable_thinking: CONFIG.enableThinking,
      thinking_budget: CONFIG.enableThinking ? CONFIG.thinkingBudget : undefined
    };

    log("请求大模型中 (首次)...", { 
      model: CONFIG.model, 
      promptChars: userContent.length,
      useStream: CONFIG.useStream 
    });

    let content;
    if (CONFIG.useStream) {
      // 使用流式响应
      content = await gmRequestJsonStream(url, payload);
    } else {
      // 使用非流式响应
      const json = await gmRequestJson(url, payload);
      content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    }

    if (typeof content !== "string" || !content.trim()) {
      throw new Error("大模型返回为空");
    }

    verboseLog("LLM 原始返回 (首次)", content);

    const code = stripCodeFencesIfAny(content);
    verboseLog("处理后的代码 (首次)", code);

    return code;
  }

  // 重试调用 Agent（带错误信息，不带代码模板）
  async function callAgentRetry(params) {
    const learningText = params.learningText;
    const imageUrls = params.imageUrls;
    const previousCode = params.previousCode;
    const evalResult = params.evalResult;

    const url = buildChatCompletionsUrl();

    // 构建错误信息
    let errorInfo = "评测失败。";
    if (evalResult && evalResult.test_sets && evalResult.test_sets.length > 0) {
      const testSet = evalResult.test_sets[0];
      errorInfo = [
        "## 评测失败信息",
        "- 编译状态: " + (testSet.compile_success === 1 ? "成功" : "失败"),
        "- 预期输出:",
        "```",
        testSet.output || "(空)",
        "```",
        "- 实际输出:",
        "```",
        testSet.actual_output || "(空)",
        "```"
      ].join("\n");

      if (evalResult.last_compile_output) {
        errorInfo += "\n- 编译/运行信息: " + evalResult.last_compile_output;
      }
    }

    const userContentParts = [
      "## 任务描述",
      "你之前提交的代码评测失败了，请根据错误信息修正代码。",
      "",
      "## 学习内容（任务要求）",
      learningText || "(空)",
      "",
      errorInfo,
      "",
      "## 你之前提交的代码",
      "```",
      previousCode || "(空)",
      "```",
      "",
      "## 输出要求",
      "请输出修正后的【完整代码文件】。仔细分析预期输出和实际输出的差异，找出问题所在。"
    ];

    const userContent = userContentParts.join("\n");

    verboseLog("User Prompt (重试)", userContent);

    const payload = {
      model: CONFIG.model,
      temperature: CONFIG.temperature,
      max_tokens: CONFIG.maxTokens,
      messages: [
        { role: "system", content: CONFIG.systemPrompt },
        { role: "user", content: userContent }
      ],
      // 深度思考模式配置
      enable_thinking: CONFIG.enableThinking,
      thinking_budget: CONFIG.enableThinking ? CONFIG.thinkingBudget : undefined
    };

    log("请求大模型中 (重试)...", { 
      model: CONFIG.model, 
      promptChars: userContent.length,
      useStream: CONFIG.useStream 
    });

    let content;
    if (CONFIG.useStream) {
      // 使用流式响应
      content = await gmRequestJsonStream(url, payload);
    } else {
      // 使用非流式响应
      const json = await gmRequestJson(url, payload);
      content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    }

    if (typeof content !== "string" || !content.trim()) {
      throw new Error("大模型返回为空");
    }

    verboseLog("LLM 原始返回 (重试)", content);

    const code = stripCodeFencesIfAny(content);
    verboseLog("处理后的代码 (重试)", code);

    return code;
  }

  // ============= 主流程 =============
  /**
   * 执行一次完整的做题流程
   * @returns {object|null} 评测结果，如果通过则返回结果对象，否则返回 null
   */
  async function runOnce() {
    ensureConfig();

    log("========== 开始一次流程 ==========");

    // Step 1: 重置代码为模板（同时从网络请求捕获原始代码）
    log("[1/6] 重置代码为模板...");
    const resetResult = await resetCodeToTemplate();

    // Step 2: 读取学习内容
    log("[2/6] 读取学习内容...");
    const learning = getLearningContent();
    log("学习内容读取完成", { textChars: learning.text.length, images: learning.images.length });
    verboseLog("学习内容", learning.text);

    // Step 3: 获取代码模板（优先使用从网络请求捕获的原始代码）
    log("[3/6] 获取代码模板...");
    let templateCode = "";
    let templateSource = "";

    if (resetResult.code) {
      // 优先使用从网络请求捕获的原始代码
      templateCode = resetResult.code;
      templateSource = "network-intercepted";
      log("使用从网络请求捕获的原始代码模板，长度:", templateCode.length);
    } else {
      // 回退到从编辑器读取
      warn("未能从网络请求获取代码模板，回退到从编辑器读取");
      const template = getCurrentCodeTemplate();
      templateCode = template.code;
      templateSource = template.source;
    }

    log("代码模板获取完成", { source: templateSource, codeChars: templateCode.length });
    verboseLog("代码模板", templateCode);

    // 获取 Monaco 引用（用于后续写入）
    const monacoRef = getMonacoCodeByAPI();
    
    // Step 4: 首次调用 Agent
    log("[4/6] 调用远程 Agent (首次)...");
    let currentCode = await callAgentFirstTime({
      learningText: learning.text,
      imageUrls: learning.images,
      codeTemplate: templateCode
    });
    log("Agent 返回完成", { codeChars: currentCode.length });

    // Step 5: 写入代码并评测
    log("[5/6] 写入代码并评测...");
    setEditorCode(currentCode, monacoRef ? monacoRef.monaco : null, monacoRef ? monacoRef.model : null);

    // 等待一下让编辑器更新
    await sleep(500);

    // 点击评测
    await clickRunEvaluate();

    // 等待评测结果
    log("[6/6] 等待评测结果...");
    let evalResult = null;
    try {
      evalResult = await waitForEvalResult();
    } catch (e) {
      warn("等待评测结果失败:", e.message);
    }

    // 检查是否通过
    if (evalResult) {
      const passed = isEvalPassed(evalResult);
      if (passed) {
        log("========== 评测通过！==========");
        return evalResult;
      }

      log("评测未通过，错误数:", evalResult.sets_error_count);

      // 重试逻辑
      for (let retry = 0; retry < CONFIG.maxRetryCount; retry++) {
        log("========== 开始重试 (" + (retry + 1) + "/" + CONFIG.maxRetryCount + ") ==========");

        // 调用 Agent 重试（带错误信息，不带代码模板）
        const retryCode = await callAgentRetry({
          learningText: learning.text,
          imageUrls: learning.images,
          previousCode: currentCode,
          evalResult: evalResult
        });

        currentCode = retryCode;

        // 写入代码
        setEditorCode(currentCode, monacoRef ? monacoRef.monaco : null, monacoRef ? monacoRef.model : null);
        await sleep(500);

        // 点击评测
        await clickRunEvaluate();

        // 等待评测结果
        try {
          evalResult = await waitForEvalResult();
        } catch (e) {
          warn("等待评测结果失败:", e.message);
          break;
        }

        if (evalResult && isEvalPassed(evalResult)) {
          log("========== 重试后评测通过！==========");
          return evalResult;
        }

        log("重试后仍未通过，错误数:", evalResult ? evalResult.sets_error_count : "未知");
      }
    }

    log("========== 流程结束（未通过）==========");
    return null;
  }

  /**
   * 连续执行所有关卡
   * 评测通过后自动进入下一关继续执行
   * @param {boolean} isResuming - 是否是从页面刷新后恢复执行
   */
  async function runAllLevels(isResuming) {
    // 尝试获取执行锁
    // 如果是恢复执行，强制获取锁（因为旧页面已经不存在了）
    if (!tryAcquireLock(isResuming)) {
      warn("无法获取执行锁，可能有其他任务正在执行");
      return;
    }

    try {
      if (!isResuming) {
        // 首次开始连续执行，初始化状态
        saveAutoRunState({
          enabled: true,
          startTime: Date.now(),
          completedLevels: 0
        });
        log("========== 开始连续执行所有关卡 ==========");
      } else {
        // 从页面刷新后恢复
        const state = getAutoRunState();
        if (state && state.completedLevels !== undefined) {
          log("========== 恢复连续执行（已完成 " + state.completedLevels + " 关）==========");
        }
      }

      const state = getAutoRunState();
      let levelCount = state ? (state.completedLevels || 0) : 0;
      const maxLevels = 100; // 防止无限循环

      while (levelCount < maxLevels) {
        levelCount++;
        log("========== 第 " + levelCount + " 关 ==========");

        // 执行当前关卡
        const evalResult = await runOnce();

        // 检查是否通过
        if (!evalResult || !isEvalPassed(evalResult)) {
          log("当前关卡未通过，停止执行");
          clearAutoRunState();
          releaseLock();
          break;
        }

        // 更新已完成关卡数
        saveAutoRunState({
          enabled: true,
          startTime: state ? state.startTime : Date.now(),
          completedLevels: levelCount
        });

        // 检查是否有下一关
        if (!hasNextLevel(evalResult)) {
          log("========== 所有关卡已完成！==========");
          log("共完成 " + levelCount + " 关");
          clearAutoRunState();
          releaseLock();
          break;
        }

        // 自动进入下一关
        if (CONFIG.autoNextLevel) {
          log("准备进入下一关: " + evalResult.next_game);

          // 重要：等待弹窗渲染（评测结果返回后，弹窗需要时间渲染）
          log("等待通过弹窗渲染...");
          await sleep(2000);

          // 等待弹窗出现并点击下一关
          const clicked = await clickNextLevelButton();
          if (!clicked) {
            warn("无法点击下一关按钮，停止执行");
            clearAutoRunState();
            releaseLock();
            break;
          }

          // 点击后页面会刷新，脚本会重新加载
          // 状态已保存到 localStorage，页面加载后会自动继续
          // 注意：锁会在页面刷新后重新获取，所以这里不需要释放
          log("页面即将刷新，将在新页面自动继续执行...");
          return; // 结束当前执行，等待页面刷新后自动恢复
        } else {
          log("自动下一关已禁用，停止执行");
          clearAutoRunState();
          releaseLock();
          break;
        }
      }

      if (levelCount >= maxLevels) {
        warn("达到最大关卡数限制 (" + maxLevels + ")，停止执行");
      }

      clearAutoRunState();
      releaseLock();
      log("========== 全部流程结束 ==========");
    } catch (e) {
      // 出错时确保释放锁
      releaseLock();
      clearAutoRunState();
      throw e;
    }
  }

  // ============= 可拖拽按钮 =============
  function createFloatingButton() {
    const btn = document.createElement("button");
    btn.textContent = "AutoSolve";
    btn.type = "button";
    btn.id = "autosolve-btn";

    // 读取保存的位置
    let pos = CONFIG.buttonPosition;
    try {
      if (typeof GM_getValue === "function") {
        const saved = GM_getValue("buttonPosition");
        if (saved) pos = saved;
      }
    } catch (e) {}

    btn.style.cssText = [
      "position: fixed",
      "right: " + pos.right + "px",
      "bottom: " + pos.bottom + "px",
      "z-index: 999999",
      "padding: 10px 16px",
      "border-radius: 8px",
      "border: none",
      "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      "color: #fff",
      "font-size: 14px",
      "font-weight: 600",
      "cursor: move",
      "box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4)",
      "transition: box-shadow 0.3s ease, transform 0.1s ease",
      "user-select: none"
    ].join(";");

    // 拖拽相关变量
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let btnStartRight = 0;
    let btnStartBottom = 0;
    let hasMoved = false;

    btn.addEventListener("mousedown", function(e) {
      if (e.button !== 0) return; // 只响应左键
      isDragging = true;
      hasMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      btnStartRight = parseInt(btn.style.right) || pos.right;
      btnStartBottom = parseInt(btn.style.bottom) || pos.bottom;
      btn.style.transition = "none";
      e.preventDefault();
    });

    document.addEventListener("mousemove", function(e) {
      if (!isDragging) return;

      const deltaX = dragStartX - e.clientX;
      const deltaY = dragStartY - e.clientY;

      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        hasMoved = true;
      }

      let newRight = btnStartRight + deltaX;
      let newBottom = btnStartBottom + deltaY;

      // 边界限制
      const maxRight = window.innerWidth - btn.offsetWidth - 10;
      const maxBottom = window.innerHeight - btn.offsetHeight - 10;
      newRight = Math.max(10, Math.min(newRight, maxRight));
      newBottom = Math.max(10, Math.min(newBottom, maxBottom));

      btn.style.right = newRight + "px";
      btn.style.bottom = newBottom + "px";
    });

    document.addEventListener("mouseup", function(e) {
      if (!isDragging) return;
      isDragging = false;
      btn.style.transition = "box-shadow 0.3s ease, transform 0.1s ease";

      // 保存位置
      const newPos = {
        right: parseInt(btn.style.right) || 16,
        bottom: parseInt(btn.style.bottom) || 16
      };
      try {
        if (typeof GM_setValue === "function") {
          GM_setValue("buttonPosition", newPos);
        }
      } catch (e) {}
    });

    // 全局执行锁（防止重复执行）
    let running = false;
    let clickTimer = null;

    // 点击事件（只有没有拖动时才触发）
    // 单击执行当前关，双击执行所有关卡
    btn.addEventListener("click", function(e) {
      if (hasMoved) {
        hasMoved = false;
        return;
      }

      if (running) {
        warn("正在执行中，请稍等...");
        return;
      }

      // 检测是否双击
      if (clickTimer) {
        // 双击：执行所有关卡
        clearTimeout(clickTimer);
        clickTimer = null;
        executeAllLevels();
      } else {
        // 单击：等待一段时间确认不是双击
        clickTimer = setTimeout(function() {
          clickTimer = null;
          executeSingleLevel();
        }, 250);
      }
    });

    async function executeSingleLevel() {
      running = true;
      const oldText = btn.textContent;
      btn.textContent = "执行中...";
      btn.style.cursor = "wait";

      try {
        await runOnce();
      } catch (e) {
        error("执行失败:", e);
        alert(LOG_PREFIX + " 执行失败:\n" + String(e && e.message ? e.message : e));
      } finally {
        running = false;
        btn.textContent = oldText;
        btn.style.cursor = "move";
      }
    }

    async function executeAllLevels() {
      running = true;
      const oldText = btn.textContent;
      btn.textContent = "连续执行中...";
      btn.style.cursor = "wait";
      btn.style.background = "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)";

      try {
        await runAllLevels(false); // false 表示首次执行
      } catch (e) {
        error("执行失败:", e);
        alert(LOG_PREFIX + " 执行失败:\n" + String(e && e.message ? e.message : e));
        clearAutoRunState(); // 出错时清除状态
      } finally {
        running = false;
        btn.textContent = oldText;
        btn.style.cursor = "move";
        btn.style.background = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
      }
    }

    // 悬停效果
    btn.addEventListener("mouseenter", function() {
      if (!isDragging) {
        btn.style.boxShadow = "0 6px 20px rgba(102, 126, 234, 0.5)";
      }
    });
    btn.addEventListener("mouseleave", function() {
      if (!isDragging) {
        btn.style.boxShadow = "0 4px 15px rgba(102, 126, 234, 0.4)";
      }
    });

    document.documentElement.appendChild(btn);

    // 添加提示
    log("提示: 单击按钮执行当前关，双击按钮连续执行所有关卡");
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== "function") return;

    GM_registerMenuCommand("AutoSolve: 执行当前关", async function() {
      try {
        await runOnce();
      } catch (e) {
        error("执行失败:", e);
        alert(LOG_PREFIX + " 执行失败:\n" + String(e && e.message ? e.message : e));
      }
    });

    GM_registerMenuCommand("AutoSolve: 连续执行所有关卡", async function() {
      try {
        await runAllLevels(false); // false 表示首次执行
      } catch (e) {
        error("执行失败:", e);
        alert(LOG_PREFIX + " 执行失败:\n" + String(e && e.message ? e.message : e));
        clearAutoRunState();
      }
    });

    GM_registerMenuCommand("AutoSolve: 停止连续执行", function() {
      clearAutoRunState();
      releaseLock();
      log("已停止连续执行并释放锁");
    });

    GM_registerMenuCommand("AutoSolve: 切换详细日志", function() {
      CONFIG.verboseLog = !CONFIG.verboseLog;
      log("详细日志已" + (CONFIG.verboseLog ? "开启" : "关闭"));
    });

    GM_registerMenuCommand("AutoSolve: 切换流式响应", function() {
      CONFIG.useStream = !CONFIG.useStream;
      log("流式响应已" + (CONFIG.useStream ? "开启" : "关闭") + 
          (CONFIG.useStream ? "（推荐用于深度思考模型）" : ""));
    });

    GM_registerMenuCommand("AutoSolve: 切换深度思考模式", function() {
      CONFIG.enableThinking = !CONFIG.enableThinking;
      log("深度思考模式已" + (CONFIG.enableThinking ? "开启" : "关闭") + 
          (CONFIG.enableThinking ? "（模型会先思考再输出，耗时更长）" : "（立即输出，速度更快）"));
    });

    GM_registerMenuCommand("AutoSolve: 切换自动下一关", function() {
      CONFIG.autoNextLevel = !CONFIG.autoNextLevel;
      log("自动下一关已" + (CONFIG.autoNextLevel ? "开启" : "关闭"));
    });

    GM_registerMenuCommand("AutoSolve: 重置按钮位置", function() {
      try {
        if (typeof GM_setValue === "function") {
          GM_setValue("buttonPosition", { right: 16, bottom: 16 });
        }
      } catch (e) {}
      const btn = document.getElementById("autosolve-btn");
      if (btn) {
        btn.style.right = "16px";
        btn.style.bottom = "16px";
      }
      log("按钮位置已重置");
    });

    GM_registerMenuCommand("AutoSolve: 清除所有数据", function() {
      const confirmed = confirm(
        "确认清除所有数据？\n\n这将清除：\n" +
        "- 连续执行状态\n" +
        "- 执行锁\n" +
        "- 按钮位置\n" +
        "- 其他配置\n\n" +
        "此操作不可恢复！"
      );
      
      if (!confirmed) return;

      try {
        // 清除连续执行状态
        clearAutoRunState();
        
        // 释放执行锁
        releaseLock();
        
        // 清除按钮位置
        if (typeof GM_setValue === "function") {
          GM_setValue("buttonPosition", null);
        } else {
          localStorage.removeItem("buttonPosition");
        }
        
        // 重置按钮位置到默认
        const btn = document.getElementById("autosolve-btn");
        if (btn) {
          btn.style.right = "16px";
          btn.style.bottom = "16px";
        }
        
        log("已清除所有存储数据");
        alert("数据已清除！");
      } catch (e) {
        error("清除数据时出错:", e);
        alert("清除数据失败: " + (e.message || e));
      }
    });
  }

  function main() {
    log("脚本已加载 v0.7.2");
    log("修复: 现在通过拦截网络请求获取原始代码模板！");
    log("操作提示: 单击按钮执行当前关，双击按钮连续执行所有关卡");
    log("配置状态:");
    log("  - 流式响应:", CONFIG.useStream ? "✓ 已启用" : "✗ 已禁用");
    log("  - 深度思考:", CONFIG.enableThinking ? "✓ 已启用 (budget: " + CONFIG.thinkingBudget + ")" : "✗ 已禁用");
    log("  - 详细日志:", CONFIG.verboseLog ? "✓ 已启用" : "✗ 已禁用");

    if (typeof GM_xmlhttpRequest !== "function") {
      warn("GM_xmlhttpRequest 不可用！");
    } else {
      log("GM_xmlhttpRequest 可用");
    }

    if (typeof unsafeWindow !== "undefined") {
      log("unsafeWindow 可用");
    } else {
      warn("unsafeWindow 不可用");
    }

    // 设置请求拦截器（用于评测结果监听）
    setupRequestInterceptor();

    // 设置代码模板拦截器（用于捕获原始代码）
    setupCodeInterceptor();
    setupFetchInterceptor();

    // 延迟检查 Monaco
    setTimeout(function() {
      var monaco = findMonacoInstance();
      if (monaco) {
        log("Monaco 实例已就绪");
      } else {
        warn("未找到 Monaco 实例，将使用 DOM 兜底方案");
      }
    }, 2000);

    registerMenu();
    createFloatingButton();

    // 检查是否需要自动恢复连续执行
    const autoRunState = getAutoRunState();
    if (autoRunState && autoRunState.enabled) {
      log("检测到未完成的连续执行任务，将自动恢复...");
      log("已完成关卡数:", autoRunState.completedLevels || 0);
      
      // 等待页面完全加载后再恢复执行
      setTimeout(async function() {
        try {
          // 检查页面是否就绪
          const monaco = findMonacoInstance();
          const learningPanel = document.querySelector(CONFIG.selectors.learningPanel);
          
          if (monaco || learningPanel) {
            log("页面就绪，开始恢复执行...");
            
            // 更新按钮状态为"连续执行中"
            const btn = document.getElementById("autosolve-btn");
            if (btn) {
              btn.textContent = "连续执行中...";
              btn.style.cursor = "wait";
              btn.style.background = "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)";
            }
            
            await runAllLevels(true); // true 表示恢复执行
            
            // 恢复按钮状态
            if (btn) {
              btn.textContent = "AutoSolve";
              btn.style.cursor = "move";
              btn.style.background = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
            }
          } else {
            warn("页面未就绪，放弃自动恢复");
            clearAutoRunState();
          }
        } catch (e) {
          error("自动恢复执行失败:", e);
          clearAutoRunState();
          
          // 恢复按钮状态
          const btn = document.getElementById("autosolve-btn");
          if (btn) {
            btn.textContent = "AutoSolve";
            btn.style.cursor = "move";
            btn.style.background = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
          }
        }
      }, 3000); // 等待 3 秒确保页面加载完成
    }
  }

  main();
})();

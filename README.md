# AutoSolve 油猴脚本

> **免责声明**：本项目仅供研究与学习用途，用于演示页面自动化、Monaco 编辑器交互、网络请求拦截及 OpenAI API 调用等技术。请遵守目标网站的服务条款，严禁用于考试作弊、作业代做等违规行为。使用者需自行承担全部风险与责任。

## 功能

- 从页面提取学习内容（文本与图片）
- 获取代码编辑器模板
- 调用 OpenAI 兼容 API 生成代码
- 自动写入 Monaco 编辑器
- 支持流式/非流式响应
- 悬浮按钮与菜单控制

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 创建新脚本，将 `script.js` 内容粘贴进去
3. 保存并启用脚本

## 配置

打开脚本，修改顶部 `CONFIG` 对象：

```javascript
const CONFIG = {
    baseUrl: 'https://your-api-endpoint.com',  // API 地址
    apiKey: 'your-api-key',                     // API 密钥（勿提交到仓库）
    model: 'gpt-4o',                            // 模型名称
    useStream: true,                            // 流式响应（推荐开启）
    enableThinking: false,                      // 深度思考模式
    // ...
};
```

**重要提示**：
- `apiKey` 请勿提交到公开仓库
- **不建议开启 `enableThinking` 深度思考模式**，开启后模型输出可能不稳定，容易产生非预期格式的内容

## 使用

脚本加载后会在页面右下角显示悬浮按钮，点击即可执行。

也可通过 Tampermonkey 菜单操作：
- 执行当前关
- 连续执行所有关卡
- 停止连续执行
- 切换各项开关（详细日志/流式响应/深度思考/自动下一关）
- 重置按钮位置
- 清除所有数据

## 常见问题

**请求失败 / 401 错误**
- 检查 `baseUrl` 和 `apiKey` 是否正确

**写入编辑器失败**
- 等待页面完全加载后重试

**返回内容格式异常**
- 开启 `verboseLog` 查看详细日志
- 确认已关闭深度思考模式

## 许可证

[MIT](LICENSE)

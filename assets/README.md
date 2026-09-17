# assets/

第三方前端库，随插件一起分发，供生成的报告**离线自包含**使用（不依赖 CDN，打开即渲染）。

| 文件 | 版本 | 来源 | 许可 |
| :--- | :--- | :--- | :--- |
| `echarts.min.js` | 5.5.1 | https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js | Apache-2.0（见 https://github.com/apache/echarts/blob/master/LICENSE ） |

## 为什么放在这里

`position review --html` 生成的持仓分析报告是**单文件 HTML**，把 ECharts 内联进去后：

- 断网/外链被墙也能正常出图（不会白屏或一直转圈）
- 报告可直接归档、外发，长期打开不依赖第三方 CDN 可用性

若该文件缺失（例如被裁剪的发行包），报告生成时会自动回退到 CDN 引用，功能不受影响但需要联网。

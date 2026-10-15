# 极简个人博客

这是一个使用 Astro + Markdown 构建的中文个人博客起步项目，适合综合博客。

## 本地预览（可选）

需要先安装 Node.js。进入项目目录后运行：

```bash
npm install
npm run dev
```

打开终端显示的本地地址（通常是 http://localhost:4321）。

## 添加文章

在 `src/content/blog/` 新建 `.md` 文件。文件开头使用以下格式：

```md
---
title: "文章标题"
description: "一句话介绍文章"
pubDate: 2026-10-15
category: "生活"
tags: ["随笔", "记录"]
---

正文从这里开始。支持 **粗体**、列表、链接和代码块。
```

## 部署到 Cloudflare

1. 将整个项目上传到一个 GitHub 仓库。
2. 在 Cloudflare 控制台进入 Workers & Pages，创建应用并导入该仓库。
3. 如果界面要求填写构建设置，使用：
   - Build command: `npm run build`
   - Build output directory: `dist`
4. 点击部署。部署成功后会得到一个免费子域名。
5. 后续把新文章提交到 GitHub，Cloudflare 会自动重新构建发布。

首次部署需要创建 GitHub 和 Cloudflare 账号，并授权它们连接。免费额度和平台界面可能随时间变化。

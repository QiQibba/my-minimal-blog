# 如何添加商品

商品资料使用 Astro content collection 管理。每件商品一个 Markdown 文件，放在 `src/content/products/`。商品列表页、首页推荐区和详情页都会自动读取此目录中的商品，无需修改页面代码。

## 新增商品步骤

1. 准备商品图片（可选），放入 `public/images/products/`。图片会以静态文件发布。
2. 复制 [`templates/product-template.md`](./templates/product-template.md)，将副本保存到 `src/content/products/`，例如 `travel-mug.md`。也可以参考 [`example-product.md`](../src/content/products/example-product.md) 中的字段注释；该文件本身是示例，继续保持 `sample: true`。
3. 将副本文件名设为唯一的小写英文/数字标识，单词之间用连字符，例如 `travel-mug.md`。Astro 使用文件名生成 slug，详情页地址为 `https://9ik.cc/products/travel-mug/`。不要在 frontmatter 中填写 `slug` 字段（Astro 会将其作为保留字段处理）。
4. 填写 frontmatter 中的商品信息，并将正文替换为经过确认的商品详细介绍。不要保留模板提示文字。
5. 正式商品无需填写 `sample` 字段（默认为 `false`）；若内容仍是演示资料则设为 `true`，并明确标注示例。
6. 运行 `npm run build`。商品字段不符合要求或文件名 slug 重复时，构建会报错提示。

详情页 URL 使用 Markdown 文件名生成的 slug。商品 collection 中的文件名必须唯一；建议保持简洁并只使用小写英文字母、数字和连字符，方便手工维护。

## 字段填写

| 字段 | 用途 | 填写方式 |
| --- | --- | --- |
| 文件名 | 唯一详情页标识 | 文件名（不含 `.md`）作为 slug；小写英文、数字和连字符，不可重复 |
| `name` | 商品名称 | 必填，填写确认后的真实名称 |
| `category` | 商品分类 | 必填，例如实际使用的分类名 |
| `summary` | 列表简介 | 必填，一两句话概括商品 |
| `image` | 商品图片 | 可选；填写 `src` 和供无障碍阅读的 `alt` |
| `specs` | 规格 | 可选数组；每项填写 `label` 和 `value`，默认为空数组 |
| `features` | 特点 | 可选数组；只填写经过确认的特点，默认为空数组 |
| `recommended` | 首页推荐状态 | 可选，默认为 `false`；`true` 会在商品列表前排显示“推荐” |
| `contact` | 咨询入口 | 可选，默认为站内 `contact` 联系页 |
| `sample` | 示例标记 | 可选，默认为 `false`；仅示例资料设为 `true` |
| Markdown 正文 | 详细介绍 | 填写完整介绍，可使用 Markdown 标题、段落和列表 |

没有图片、规格或特点时，可省略 `image`，并将 `specs`、`features` 留为 `[]`。页面会显示图片待补充、规格未提供等提示，不会凭空补写商品信息。若图片路径失效或图片无法加载，页面也会回退到“商品图片待补充”占位，不展示浏览器破图图标。`contact.page` 目前固定为 `contact`，链接会自动带上 Astro 的部署基础路径。

## 图片目录与路径

请将图片放在：

```text
public/images/products/
```

例如图片文件为 `public/images/products/travel-mug.webp`，frontmatter 可填写：

```yaml
image:
  src: "/images/products/travel-mug.webp"
  alt: "商品图片的简要描述"
```

文件放在 `public/images/products/`；`src` 填写从网站根路径开始的图片 URL，不要把 `public` 写入路径，例如 `/images/products/travel-mug.webp`。也可使用 HTTPS 图片地址；避免使用不稳定或未经授权的外部图片来源。

## 模板与现有示例

干净模板位于 [`docs/templates/product-template.md`](./templates/product-template.md)，不在 Astro 商品 collection 目录内，不会被当作真实商品发布。`src/content/products/example-product.md` 是明确标注的示例条目；添加真实商品时请新建文件，不要把示例资料误当成已确认商品信息。

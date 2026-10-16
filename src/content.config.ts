import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    category: z.string().default('随笔'),
    tags: z.array(z.string()).default([]),
  }),
});

const tutorials = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    sample: z.boolean().default(true),
  }),
});

const products = defineCollection({
  type: 'content',
  schema: z.object({
    name: z.string().trim().min(1, '商品名称不能为空'),
    category: z.string().trim().min(1, '商品分类不能为空'),
    summary: z.string().trim().min(1, '商品列表简介不能为空'),
    image: z.object({
      src: z.string().trim().min(1).refine(
        (src) =>
          /^\/images\/products\/[^?#\s]+$/.test(src) ||
          /^https:\/\/\S+$/i.test(src),
        '商品图片必须位于 /images/products/，或使用 HTTPS 地址'
      ),
      alt: z.string().trim().min(1, '商品图片替代文字不能为空'),
    }).optional(),
    specs: z.array(z.object({
      label: z.string().trim().min(1, '规格名称不能为空'),
      value: z.string().trim().min(1, '规格内容不能为空'),
    })).default([]),
    features: z.array(z.string().trim().min(1, '商品特点不能为空')).default([]),
    recommended: z.boolean().default(false),
    contact: z.object({
      label: z.string().trim().min(1).default('咨询客服'),
      page: z.literal('contact').default('contact'),
    }).default({}),
    sample: z.boolean().default(false),
  }),
});

export const collections = { blog, tutorials, products };

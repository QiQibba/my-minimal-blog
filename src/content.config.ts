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

export const collections = { blog };

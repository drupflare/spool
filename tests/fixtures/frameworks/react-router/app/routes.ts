import { index, layout, route, type RouteConfig } from '@react-router/dev/routes';

export default [
	index('routes/home.tsx'),
	route('about', 'routes/about.tsx'),
	route('articles/:id', 'routes/article.tsx'),
	route('docs/*', 'routes/docs.tsx'),
	route('opt/:id?', 'routes/opt.tsx'),
	route('blog', 'routes/blog.tsx', [
		index('routes/blog-index.tsx'),
		route(':slug', 'routes/blog-post.tsx')
	]),
	layout('routes/layout.tsx', [route('news', 'routes/news.tsx')])
] satisfies RouteConfig;

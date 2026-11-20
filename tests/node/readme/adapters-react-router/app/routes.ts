export default [
	{
		id: 'root',
		path: '',
		file: 'root.tsx',
		children: [
			{ index: true, file: 'home.tsx' },
			{ id: 'about', path: 'about', file: 'about.tsx' }
		]
	}
];

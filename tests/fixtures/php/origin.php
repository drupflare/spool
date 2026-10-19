<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$dir = getenv('SPOOL_PHP_DIR');

if ($path === '/site.css') {
	header('Content-Type: text/css');
	header('Cache-Control: public, max-age=31536000');
	echo 'main{max-width:60ch}';
	return;
}

if ($path === '/login') {
	setcookie('SESS', 'abc', ['path' => '/']);
	header('Content-Type: text/html; charset=UTF-8');
	echo '<!doctype html><html><head><title>login</title></head><body><h1>login</h1></body></html>';
	return;
}

if (!preg_match('#^/p/(\d+)$#', $path, $match)) {
	http_response_code(404);
	echo 'not found';
	return;
}

$id = $match[1];
$note = is_file("$dir/note-$id") ? file_get_contents("$dir/note-$id") : 'original';
$nav = '';
foreach ([1, 2, 3] as $n) {
	$nav .= "<a href=\"/p/$n\">/p/$n</a> ";
}

header('Content-Type: text/html; charset=UTF-8');
header('Cache-Control: max-age=0, public');
header("X-Drupal-Cache-Tags: node:$id config:system.menu.main rendered");
echo "<!doctype html><html><head><meta charset=\"utf-8\"><title>Page $id</title><link rel=\"stylesheet\" href=\"/site.css\"></head><body><nav>$nav</nav><main><h1>Page $id</h1><p id=\"note\">$note</p></main></body></html>";

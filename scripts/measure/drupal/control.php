<?php

// required by router.php before Drupal boots; every /__b4/ route ends in reply()

require __DIR__ . '/bootstrap.php';

const B4_ARMS = ['uncached', 'render-warm', 'page-cache'];

function reply(int $status, array $body): void {
	http_response_code($status);
	header('content-type: application/json');
	echo json_encode($body);
	exit;
}

$route = substr(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), strlen('/__b4/'));

switch ($route) {
	case 'null':
		echo 'ok';
		exit;

	case 'arm':
		$name = $_GET['name'] ?? '';
		if (!in_array($name, B4_ARMS, true)) {
			reply(400, ['error' => 'unknown arm']);
		}
		file_put_contents(B4_STATE . '/arm.txt', $name);
		reply(200, ['arm' => $name]);

	case 'clear':
		exec('php -d auto_prepend_file=/rig/b4/fiber-shim.php /rig/b4/clear.php 2>&1', $out, $code);
		reply($code === 0 ? 200 : 500, ['code' => $code, 'out' => $out]);

	case 'info':
		preg_match("/const VERSION = '([^']+)'/", file_get_contents('/rig/drupal/core/lib/Drupal.php'), $m);
		reply(200, [
			'php' => PHP_VERSION,
			'drupal' => $m[1] ?? 'unknown',
			'opcache' => 'enable_cli=' . ini_get('opcache.enable_cli') . ', memory_consumption=' . ini_get('opcache.memory_consumption'),
			'workers' => getenv('PHP_CLI_SERVER_WORKERS') ?: 'unset',
			'hostname' => gethostname(),
			'urls' => json_decode(file_get_contents(B4_STATE . '/urls.json'), true),
		]);

	default:
		reply(404, ['error' => 'no such control route']);
}

<?php

// router for php -S in the drupal-render rig; the control routes exist only in that container

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

if (str_starts_with($path, '/__b4/')) {
	require __DIR__ . '/control.php';
}

if ($path !== '/' && is_file('/rig/drupal' . $path)) {
	return false;
}

$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/rig/drupal/index.php';
chdir('/rig/drupal');
require '/rig/drupal/index.php';

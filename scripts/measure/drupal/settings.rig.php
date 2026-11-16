<?php

// included from sites/default/settings.php only when SPOOL_B4_RIG=1; the arm file is written by control.php

$arm = is_file('/rig/state/arm.txt') ? trim(file_get_contents('/rig/state/arm.txt')) : 'page-cache';

$settings['trusted_host_patterns'] = ['^b4-srv(:\d+)?$', '^localhost(:\d+)?$'];

// Drupal 11.4 has no cache.backend.null; a memory bin lives only in the request that made it.
if ($arm === 'uncached') {
	$settings['cache']['bins']['page'] = 'cache.backend.memory.memory';
	$settings['cache']['bins']['dynamic_page_cache'] = 'cache.backend.memory.memory';
	$settings['cache']['bins']['render'] = 'cache.backend.memory.memory';
} elseif ($arm === 'render-warm') {
	$settings['cache']['bins']['page'] = 'cache.backend.memory.memory';
}

<?php

require __DIR__ . '/bootstrap.php';

b4_boot();

foreach (['page', 'dynamic_page_cache', 'render'] as $bin) {
	Drupal::cache($bin)->deleteAll();
}

echo "cleared\n";

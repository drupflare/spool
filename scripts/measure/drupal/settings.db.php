<?php

// the rig's sqlite database; the quick installer does not write one into settings.php

$databases['default']['default'] = [
	'driver' => 'sqlite',
	'database' => '/rig/db/spool-b4.sqlite',
	'prefix' => '',
	'namespace' => 'Drupal\\sqlite\\Driver\\Database\\sqlite',
	'autoload' => 'core/modules/sqlite/src/Driver/Database/sqlite/',
];

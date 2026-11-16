<?php

use Drupal\Core\DrupalKernel;
use Symfony\Component\HttpFoundation\Request;

const B4_STATE = '/rig/state';

function b4_boot(): DrupalKernel {
	chdir('/rig/drupal');
	$autoloader = require '/rig/drupal/autoload.php';
	require_once '/rig/drupal/core/includes/common.inc';
	$request = Request::create('http://b4-srv:8080/');
	$kernel = DrupalKernel::createFromRequest($request, $autoloader, 'prod');
	$kernel->boot();
	return $kernel;
}

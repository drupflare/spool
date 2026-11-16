<?php

require __DIR__ . '/bootstrap.php';

use Drupal\node\Entity\Node;
use Drupal\taxonomy\Entity\Term;

b4_boot();

mt_srand(20261115);

$words = [
	'river', 'signal', 'harbor', 'lantern', 'meadow', 'ledger', 'copper', 'orbit', 'garden',
	'compass', 'thread', 'valley', 'circuit', 'pattern', 'window', 'silver', 'anchor', 'ember',
	'forest', 'bridge', 'canvas', 'cipher', 'drift', 'engine', 'folio', 'glacier', 'hollow',
	'island', 'journal', 'kettle', 'ladder', 'marble', 'nickel', 'outpost', 'pillar', 'quarry',
	'ripple', 'summit', 'tunnel', 'upland', 'vessel', 'weather'
];
$word = fn() => $words[mt_rand(0, count($words) - 1)];
$sentence = fn() => ucfirst(implode(' ', array_map(fn() => $word(), range(1, mt_rand(6, 14))))) . '.';
$paragraph = fn() => implode(' ', array_map(fn() => $sentence(), range(1, mt_rand(3, 5))));

$tids = [];
for ($i = 1; $i <= 20; $i++) {
	$term = Term::create(['vid' => 'tags', 'name' => 'Topic ' . $i]);
	$term->save();
	$tids[] = (int) $term->id();
}

$nids = [];
for ($i = 1; $i <= 300; $i++) {
	$paras = array_map(fn() => $paragraph(), range(1, mt_rand(3, 6)));
	$a = mt_rand(0, 19);
	$b = ($a + mt_rand(1, 19)) % 20;
	$node = Node::create([
		'type' => 'article',
		'title' => 'Article ' . $i . ': ' . ucfirst($word()),
		'body' => ['value' => '<p>' . implode('</p><p>', $paras) . '</p>', 'format' => 'basic_html'],
		'field_tags' => [['target_id' => $tids[$a]], ['target_id' => $tids[$b]]],
		'promote' => 1,
		'status' => 1,
		'uid' => 1,
	]);
	$node->save();
	$nids[] = (int) $node->id();
}

file_put_contents(B4_STATE . '/urls.json', json_encode([
	'front' => '/',
	'node' => '/node/' . $nids[149],
	'term' => '/taxonomy/term/' . $tids[0],
]));

echo count($nids) . " nodes, " . count($tids) . " terms\n";

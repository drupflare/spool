<?php

// the source tree's renderer constructs PhpWasmSyncFiber, which only the PHP-WASM runtime defines
// native php gets the same surface on top of \Fiber (final, so it wraps one)

class PhpWasmSyncFiber {

	private static array $running = [];

	private \Fiber $fiber;

	public function __construct(callable $callback) {
		$this->fiber = new \Fiber($callback);
	}

	public function start(mixed ...$args): mixed {
		return $this->step(fn () => $this->fiber->start(...$args));
	}

	public function resume(mixed $value = null): mixed {
		return $this->step(fn () => $this->fiber->resume($value));
	}

	public function getReturn(): mixed {
		return $this->fiber->getReturn();
	}

	public function isStarted(): bool {
		return $this->fiber->isStarted();
	}

	public function isSuspended(): bool {
		return $this->fiber->isSuspended();
	}

	public function isRunning(): bool {
		return $this->fiber->isRunning();
	}

	public function isTerminated(): bool {
		return $this->fiber->isTerminated();
	}

	public static function getCurrent(): ?self {
		return self::$running[array_key_last(self::$running)] ?? null;
	}

	// static on purpose: Drupal calls both \PhpWasmSyncFiber::suspend() and $fiber->suspend()
	public static function suspend(mixed $value = null): mixed {
		return \Fiber::suspend($value);
	}

	private function step(callable $fn): mixed {
		self::$running[] = $this;
		try {
			return $fn();
		} finally {
			array_pop(self::$running);
		}
	}
}

import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

@Component({
	selector: 'app-page',
	template: '<h1>{{ title }}</h1>'
})
export class PageComponent {
	readonly title = inject(ActivatedRoute).snapshot.data['title'] as string;
}

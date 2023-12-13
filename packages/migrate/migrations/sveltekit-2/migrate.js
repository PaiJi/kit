import fs from 'node:fs';
import { Project, Node, SyntaxKind } from 'ts-morph';
import { log_migration, log_on_ts_modification, update_pkg } from '../../utils.js';
import path from 'node:path';

export function update_pkg_json() {
	fs.writeFileSync(
		'package.json',
		update_pkg_json_content(fs.readFileSync('package.json', 'utf8'))
	);
}

/**
 * @param {string} content
 */
export function update_pkg_json_content(content) {
	return update_pkg(content, [
		// All other bumps are done as part of the Svelte 4 migration
		['@sveltejs/kit', '^2.0.0'],
		['vite', '^5.0.0'],
		['vitest', '^1.0.0'],
		['typescript', '^5.0.0'], // should already be done by Svelte 4 migration, but who knows
		[
			'@sveltejs/vite-plugin-svelte',
			'^3.0.0',
			' (vite-plugin-svelte is a peer dependency of SvelteKit now)',
			'devDependencies'
		]
	]);
}

export function update_tsconfig() {
	fs.writeFileSync(
		'tsconfig.json',
		update_tsconfig_content(fs.readFileSync('tsconfig.json', 'utf8'))
	);
}

/** @param {string} content */
export function update_tsconfig_content(content) {
	if (!content.includes('"extends"')) {
		// Don't touch the tsconfig if people opted out of our default config
		return content;
	}

	let updated = content
		.split('\n')
		.filter(
			(line) => !line.includes('importsNotUsedAsValues') && !line.includes('preserveValueImports')
		)
		.join('\n');
	if (updated !== content) {
		log_migration(
			'Removed deprecated `importsNotUsedAsValues` and `preserveValueImports`' +
				' from tsconfig.json: https://kit.svelte.dev/docs/v2-migration-guide#updated-dependency-requirements'
		);
	}

	content = updated;
	updated = content.replace('"moduleResolution": "node"', '"moduleResolution": "bundler"');
	if (updated !== content) {
		log_migration(
			'Updated `moduleResolution` to `bundler`' +
				' in tsconfig.json: https://kit.svelte.dev/docs/v2-migration-guide#updated-dependency-requirements'
		);
	}

	return updated;
}

export function update_svelte_config() {
	fs.writeFileSync(
		'svelte.config.js',
		update_svelte_config_content(fs.readFileSync('svelte.config.js', 'utf8'))
	);
}

/**
 * @param {string} code
 */
export function update_svelte_config_content(code) {
	const regex = /\s*dangerZone:\s*{[^}]*},?/g;
	return code.replace(regex, '');
}

/**
 * @param {string} code
 * @param {boolean} _is_ts
 * @param {string} file_path
 */
export function transform_code(code, _is_ts, file_path) {
	const project = new Project({ useInMemoryFileSystem: true });
	const source = project.createSourceFile('svelte.ts', code);
	remove_throws(source);
	add_cookie_note(file_path, source);
	replace_resolve_path(source);
	return source.getFullText();
}

/**
 * `throw redirect(..)` -> `redirect(..)`
 * @param {import('ts-morph').SourceFile} source
 */
function remove_throws(source) {
	const logger = log_on_ts_modification(
		source,
		'Removed `throw` from redirect/error functions: https://kit.svelte.dev/docs/v2-migration-guide#redirect-and-error-are-no-longer-thrown-by-you'
	);

	/** @param {string} id */
	function remove_throw(id) {
		const namedImport = get_import(source, '@sveltejs/kit', id);
		if (!namedImport) return;
		for (const id of namedImport.getNameNode().findReferencesAsNodes()) {
			const call_expression = id.getParent();
			const throw_stmt = call_expression?.getParent();
			if (Node.isCallExpression(call_expression) && Node.isThrowStatement(throw_stmt)) {
				throw_stmt.replaceWithText(call_expression.getText() + ';');
			}
		}
	}

	remove_throw('redirect');
	remove_throw('error');

	logger();
}

/**
 * Adds `path` option to `cookies.set/delete/serialize` calls
 * @param {string} file_path
 * @param {import('ts-morph').SourceFile} source
 */
function add_cookie_note(file_path, source) {
	const basename = path.basename(file_path);
	if (
		basename !== '+page.js' &&
		basename !== '+page.ts' &&
		basename !== '+page.server.js' &&
		basename !== '+page.server.ts' &&
		basename !== '+server.js' &&
		basename !== '+server.ts' &&
		basename !== 'hooks.server.js' &&
		basename !== 'hooks.server.ts'
	) {
		return;
	}

	const logger = log_on_ts_modification(
		source,
		'Remember to add the `path` option to `cookies.set/delete/serialize` calls: https://kit.svelte.dev/docs/v2-migration-guide#path-is-now-a-required-option-for-cookies'
	);

	const calls = [];

	for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		const expression = call.getExpression();
		if (!Node.isPropertyAccessExpression(expression)) {
			continue;
		}

		const name = expression.getName();
		if (name !== 'set' && name !== 'delete' && name !== 'serialize') {
			continue;
		}

		if (call.getText().includes('path')) {
			continue;
		}

		const options_arg = call.getArguments()[name === 'delete' ? 1 : 2];
		if (options_arg && !Node.isObjectLiteralExpression(options_arg)) {
			continue;
		}

		const parent_function = call.getFirstAncestor(
			/** @returns {ancestor is import('ts-morph').FunctionDeclaration | import('ts-morph').FunctionExpression | import('ts-morph').ArrowFunction} */
			(ancestor) => {
				// Check if this is inside a function
				const fn_declaration = ancestor.asKind(SyntaxKind.FunctionDeclaration);
				const fn_expression = ancestor.asKind(SyntaxKind.FunctionExpression);
				const arrow_fn_expression = ancestor.asKind(SyntaxKind.ArrowFunction);
				return !!fn_declaration || !!fn_expression || !!arrow_fn_expression;
			}
		);
		if (!parent_function) {
			continue;
		}

		const expression_text = expression.getExpression().getText();
		if (
			expression_text !== 'cookies' &&
			(!expression_text.includes('.') ||
				!parent_function.getParameter(expression_text.split('.')[0]))
		) {
			continue;
		}

		const parent = call.getFirstAncestorByKind(SyntaxKind.Block);
		if (!parent) {
			continue;
		}

		calls.push(() =>
			call.replaceWithText((writer) => {
				writer.setIndentationLevel(0); // prevent ts-morph from being unhelpful and adding its own indentation
				writer.write('/* @migration task: add path argument */ ' + call.getText());
			})
		);
	}

	for (const call of calls) {
		call();
	}

	logger();
}

/**
 * `resolvePath` from `@sveltejs/kit` -> `resolveRoute` from `$app/paths`
 * @param {import('ts-morph').SourceFile} source
 */
function replace_resolve_path(source) {
	const namedImport = get_import(source, '@sveltejs/kit', 'resolvePath');
	if (!namedImport) return;

	for (const id of namedImport.getNameNode().findReferencesAsNodes()) {
		id.replaceWithText('resolveRoute');
	}
	if (namedImport.getParent().getParent().getNamedImports().length === 1) {
		namedImport.getParent().getParent().getParent().remove();
	} else {
		namedImport.remove();
	}

	const paths_import = source.getImportDeclaration(
		(i) => i.getModuleSpecifierValue() === '$app/paths'
	);
	if (paths_import) {
		paths_import.addNamedImport('resolveRoute');
	} else {
		source.addImportDeclaration({
			moduleSpecifier: '$app/paths',
			namedImports: ['resolveRoute']
		});
	}
}

/**
 * @param {import('ts-morph').SourceFile} source
 * @param {string} from
 * @param {string} name
 */
function get_import(source, from, name) {
	return source
		.getImportDeclarations()
		.filter((i) => i.getModuleSpecifierValue() === from)
		.flatMap((i) => i.getNamedImports())
		.find((i) => i.getName() === name);
}
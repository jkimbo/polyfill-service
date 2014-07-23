var fs = require('fs'),
	path = require('path'),
	useragent = require('useragent'),
	uglify    = require('uglify-js'),
	tsort     = require('tsort'),
	AliasResolver = require('./aliases'),
	lookupAgent = require('./agent');

// Load additional useragent features: primarily to use: agent.satisfies to
// test a browser version against a semver string
require('useragent/features');

"use strict";

var polyfillSourceFolder = path.join(__dirname, '../polyfills');

var sources = {},
	configuredAliases = {};

fs.readdirSync(polyfillSourceFolder).forEach(function (polyfillName) {

	var polyfillPath = path.join(polyfillSourceFolder, polyfillName),
		configPath   = path.join(polyfillPath, 'config.json');

	if (!fs.existsSync(polyfillPath) || !fs.existsSync(configPath)) {
		return;
	}

	var config = require(configPath),
		polyfillSourcePath = path.join(polyfillPath, 'polyfill.js'),
		detectSourcePath = path.join(polyfillPath, 'detect.js'),
		fileContents = fs.readFileSync(polyfillSourcePath, 'utf8'),
		polyfillInfo = {
			file: fileContents,
			minifile: uglify.minify(fileContents, {fromString: true}).code,
			config: config
		};


	if (fs.existsSync(detectSourcePath)) {
		var featureGate = fs.readFileSync(detectSourcePath);
		var gatedFile = "if (" + featureGate + ") {" + fileContents + "}";

		// Verify the generated feature gate is valid javascript
		try {
			new Function(gatedFile);
		} catch(e) {
			console.error("Error generating feature gate for polyfill: " + polyfillName);
			console.error("Invalid Syntax in feature gate: '" + e.message + "'");
			console.error("The detect.js file must be a valid expression that can be inserted as the condition of an if statement");
			process.exit(1);
		}

		polyfillInfo.gatedFile = gatedFile;
		polyfillInfo.miniGatedFile = uglify.minify(gatedFile, {fromString: true}).code;
	}

	sources[polyfillName] = polyfillInfo;

	// Store alias names in a map for efficient lookup, mapping aliases to
	// polyfillNames.  An alias can map to many polyfill names. So a group
	// of polyfills can be aliased under the same name.  This is why an
	// array is created and used for the value in the map.
	config.aliases = config.aliases || [];
	config.aliases.forEach(function(aliasName) {
		if (configuredAliases[aliasName]) {
			configuredAliases[aliasName].push(polyfillName);
		} else {
			configuredAliases[aliasName] = [ polyfillName ];
		}
	});
});

AliasResolver.addResolver(function (polyfillIdentifierName) {
	// If an name can not be resolved to anything return undefined
	return configuredAliases[polyfillIdentifierName] || undefined;
});

function getPolyfillString(options) {
	var ua = useragent.lookup(options.uaString),
		uaFamily = lookupAgent(ua.family.toLowerCase()),
		explainerComment = options.minify ? [
			'Rerun without minification for verbose metadata'
		] : [
			'Polyfill bundle includes the following polyfills.  For detailed credits and licence information see http://github.com/financial-times/polyfill-service.',
			'',
			'Detected: ' + uaFamily + '/' + ua.toVersion(),
			''
		],
		currentPolyfills = {};

	// Browsers don't really use semantic versioning but tend to at least
	// have a major and minor version.  This normalises the patch version so that
	// semantic version comparison is consistent.
	if (!isNumeric(ua.patch)) {
		ua.patch = '0';
	}

	var desired = options.polyfills

	// By default conditionally include all polyfills based on the User Agent
	if (desired.length === 0) {
		desired = Object.keys(sources).map(function(name) {
			return {
				flags: [],
				name: name
			}
		})
	} else {
		desired = AliasResolver.resolvePolyfills(desired);
	}

	desired.forEach(function(polyfill) {
		var polyfillSource = sources[polyfill.name];

		if (!polyfillSource) {
			explainerComment.push('- "' + polyfill.name + '" did not match any polyfills');
			return;
		}

		var alwaysInclude = polyfill.flags.indexOf('always') !== -1;

		if (!alwaysInclude) {
			var polyfillConfig = polyfillSource.config,
				browsersConfigured = polyfillConfig && polyfillConfig.browsers;

			if (!(browsersConfigured)) {
				return;
			}

			var browserVersion = polyfillConfig.browsers[uaFamily];
			if (!(browserVersion && ua.satisfies(browserVersion))) {
				return;
			}
		}

		var shouldGate = polyfill.flags.indexOf('gated') !== -1;

		var file = polyfillSource.file;
		var minifile = polyfillSource.minifile;

		if (shouldGate && polyfillSource.gatedFile) {
			file = polyfillSource.gatedFile;
			minifile = polyfillSource.miniGatedFile;
		}

		if (!options.minify) {
			explainerComment.push(
				'- ' + polyfill.name +
				', LICENCE TODO' +
				((polyfill.aliasOf && polyfill.aliasOf.length) ? ' (' + polyfill.aliasOf.join(',') + ')' : '')
			);
		}

		currentPolyfills[polyfill.name] = options.minify ? minifile : file;
	});

	var graph = tsort();
	for (var name in currentPolyfills) {
		var config = sources[name].config;
		if (config.dependencies) {
			for (var i = 0; i < config.dependencies.length; i++) {
				graph.add(config.dependencies[i], name);
			}
		}
		else {
			graph.add(name);
		}
	}
	var orderedPolyfills = graph.sort();

	var builtExplainerComment = '/* ' + explainerComment.join('\n * ') + '\n */\n';
	var builtPolyfillString = orderedPolyfills.map(function(name) {
		return currentPolyfills[name];
	}).join('');

	return builtExplainerComment + builtPolyfillString;
}

module.exports = {
	getPolyfills: getPolyfillString
};

/**
 * jQuery: isNumeric
 * https://github.com/jquery/jquery/blob/bbdfbb4ee859fe9319b348d88120ddc2c9efbd63/src/core.js#L212
 */
function isNumeric(obj) {
	return !Array.isArray(obj) && (((obj- parseFloat(obj)) + 1) >= 0);
}
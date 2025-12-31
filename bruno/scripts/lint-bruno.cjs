#!/usr/bin/env node
/**
 * Bruno (.bru) file linter with optional auto-fix.
 *
 * Default behaviour: Read-only diagnostics.
 * Pass --fix to automatically:
 *   • Insert missing meta { name: <Derived>, type: http } for request files.
 *   • Add or patch settings { encodeUrl: true } when HTTP verbs are present.
 *
 * Ignored files:
 *   • folder.bru (documentation container)
 *   • Any file under an environments/ directory
 *   • Files with no HTTP verb blocks (treated as doc-only)
 *
 * Rules:
 *  1. meta block required only for request files (with HTTP verbs) not ignored.
 *  2. params:query presence recommended (WARN) if URL has '?' and no block.
 *  3. Warn on hardcoded descriptor URIs in validation (Check ...) files.
 *  4. Warn on mixed array/object asserts.
 *  5. Warn if validateDependency used without any {{var}} token.
 *  6. Forbid mutating verbs in read-only “Check” scenario files.
 *  7. Warn on pickSingle mismatch (heuristic refined).
 *  8. settings { encodeUrl: true } required for request files.
 */

const fs = require('fs');
const path = require('path');

// Anchor to repository root (parent directory of this scripts folder)
const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const FIX_MODE = ARGS.includes('--fix');
const JSON_MODE = ARGS.includes('--json');
const SUMMARY = { filesScanned: 0, problems: 0, errors: 0, warnings: 0, fixed: 0 };

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.bru')) acc.push(full);
  }
  return acc;
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const problems = [];
const fixes = [];

// Rule codes for suppression
// P001 = pickSingle mismatch warning
// Add more codes as needed.

function isSuppressed(fileContent, code) {
  // Directive forms accepted anywhere in file:
  // @bru-lint-disable all
  // @bru-lint-disable P001
  if (/@bru-lint-disable\s+all/.test(fileContent)) return true;
  const regex = new RegExp('@bru-lint-disable\\s+'+code+'(\n|$)');
  return regex.test(fileContent);
}

function report(file, message, level = 'ERROR') {
  problems.push({ file: path.relative(ROOT, file), level, message });
}

function lintFile(file) {
  const raw = read(file);
  SUMMARY.filesScanned++;
  const base = path.basename(file);
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const isFolder = /(^|\/)folder\.bru$/.test(rel);
  const isEnv = /(^|\/)environments\//.test(rel);
  const hasVerb = /(\n|^)\s*(get|post|put|patch|delete)\s*{/.test(raw);
  const isRequestFile = hasVerb && !isFolder && !isEnv;
  const isCheck = /^\d+\s-\sCheck/i.test(base) || base.startsWith('Check ');

  // Skip doc-only files for structural meta/settings checks
  if (!isRequestFile) {
    // Still can scan for descriptor misuse in "Check" but folder/env rarely are checks.
    return;
  }

  let txt = raw; // mutable if fixing
  let changed = false;

  // 1 meta block (only if request file)
  if (!/meta\s*{[\s\S]*?type:\s*http/i.test(txt)) {
    report(file, 'Missing or invalid meta block (must include type: http)');
    if (FIX_MODE) {
      const derivedName = base.replace(/\.bru$/,'');
      const metaBlock = `meta {\n  name: ${derivedName}\n  type: http\n}\n\n`;
      txt = metaBlock + txt;
      changed = true;
    }
  }

  // 2 params:query if URL has ?
  const getUrlMatch = /get\s*{[\s\S]*?url:\s*([^\n]+)/i.exec(txt);
  if (getUrlMatch) {
    const urlLine = getUrlMatch[1];
    if (urlLine.includes('?') && !/params:query\s*{[\s\S]*?}/i.test(txt)) {
      report(file, 'URL has query string but no params:query block', 'WARN');
    }
  }

  // 3 Hardcoded descriptor URIs
  if (isCheck) {
    if (/uri:\/\/ed-fi\.org\//.test(txt)) {
      report(file, 'Hardcoded descriptor URI found in a validation file (should rely on dynamic values)', 'ERROR');
    }
  }

  // 4 Mixed array/object asserts
  const hasArrayAssert = /res\.body:\s*isArray/.test(txt);
  const hasObjectFieldDirect = /res\.body\.[a-zA-Z0-9_]+:\s*is/.test(txt);
  if (hasArrayAssert && hasObjectFieldDirect) {
    report(file, 'Assertion mixes array semantics (res.body: isArray) with direct object field asserts (res.body.id)', 'WARN');
  }

  // 5 validateDependency token check
  if (/script:pre-request/.test(txt) && /validateDependency\(/.test(txt) && !/\{\{[a-zA-Z0-9_]+}}/.test(txt)) {
    report(file, 'validateDependency used but no variable tokens ({{var}}) present', 'WARN');
  }

  // 6 Mutating verbs in Check
  if (isCheck && /(post|put|patch|delete)\s*{/.test(txt)) {
    report(file, 'Mutating HTTP verb found in read-only certification file');
  }

  // 7 pickSingle heuristics
  const usesPickSingle = /pickSingle\(/i.test(txt);
  const hasScriptBlock = /script:post-response/.test(txt);
  const hasAssertBlock = /assert\s*{/.test(txt);
  const suppressPickRule = isSuppressed(txt, 'P001') || (!hasAssertBlock && /Sample Data\//.test(rel));
  if (!suppressPickRule) {
    if (hasArrayAssert && !usesPickSingle && hasScriptBlock) {
      report(file, 'P001 Collection response asserted as array but script lacks pickSingle(...) usage', 'WARN');
    }
    if (!hasArrayAssert && usesPickSingle) {
      report(file, 'P001 pickSingle used but response is not asserted as array', 'WARN');
    }
  }

  // 8 settings encodeUrl (accept both true and false)
  if (!/settings\s*{[\s\S]*?encodeUrl:\s*(true|false)/i.test(txt)) {
    report(file, 'Missing settings encodeUrl (should be true or false)', 'WARN');
    if (FIX_MODE) {
      // If a settings block exists, patch it; else append new block
      if (/settings\s*{[\s\S]*?}/i.test(txt)) {
        txt = txt.replace(/settings\s*{([\s\S]*?)}(?![^{]*settings)/i, (m, inner) => {
          if (/encodeUrl:\s*(true|false)/.test(inner)) return m; // race guard
          return m.replace(inner, `${inner.trim()}\n  encodeUrl: true\n`);
        });
      } else {
        txt = txt.trimEnd() + `\n\nsettings {\n  encodeUrl: true\n}\n`;
      }
      changed = true;
    }
  }

  if (FIX_MODE && changed && txt !== raw) {
    fs.writeFileSync(file, txt, 'utf8');
    fixes.push(path.relative(ROOT, file));
    SUMMARY.fixed++;
  }
}

// Run
const bruFiles = walk(ROOT).filter(f => {
  // Normalize path separators for cross-platform compatibility
  const normalizedPath = f.replace(/\\/g, '/');
  return /(^|\/)(SIS|Sample Data|Assessment)(\/|$)/.test(normalizedPath);
});
bruFiles.forEach(lintFile);

SUMMARY.problems = problems.length;
SUMMARY.errors = problems.filter(p => p.level === 'ERROR').length;
SUMMARY.warnings = problems.filter(p => p.level === 'WARN').length;

function outputHuman() {
  if (problems.length) {
    problems.forEach(p => {
      const tag = p.level === 'ERROR' ? '✗' : '⚠';
      console.log(`${tag} [${p.level}] ${p.file} :: ${p.message}`);
    });
    if (FIX_MODE && fixes.length) {
      console.log(`\nApplied fixes to ${fixes.length} file(s).`);
    }
    if (SUMMARY.errors && !FIX_MODE) {
      console.log(`\n${SUMMARY.errors} error(s) detected.`);
      process.exit(1);
    } else if (SUMMARY.errors && FIX_MODE) {
      console.log(`\n${SUMMARY.errors} error(s) remain after auto-fix (re-run lint).`);
      process.exit(1);
    } else {
      console.log(`\nLint completed with warnings.`);
    }
  } else {
    if (FIX_MODE && fixes.length) {
      console.log(`✓ All Bruno files passed after fixing ${fixes.length} file(s).`);
    } else {
      console.log('✓ All Bruno files passed lint checks. Dummy');
    }
  }
}

function outputJson() {
  const payload = { summary: SUMMARY, problems, fixedFiles: fixes };
  console.log(JSON.stringify(payload, null, 2));
  if (SUMMARY.errors) process.exit(1);
}

if (JSON_MODE) outputJson(); else outputHuman();

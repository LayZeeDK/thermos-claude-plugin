import type { Rule } from 'eslint';
import type { Literal, Node, ObjectExpression, Property, TemplateLiteral } from 'estree';

const detachedInText = /detached['"]?\s*:\s*true/;
const windowsHideInText = /windowsHide['"]?\s*:\s*true/;
const typeWrappers = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);

function isNamed(key: Node, computed: boolean, name: string): boolean {
  return (key.type === 'Identifier' && !computed && key.name === name) || (key.type === 'Literal' && key.value === name);
}

function property(node: ObjectExpression, name: string): Property | undefined {
  return node.properties.findLast(
    (candidate): candidate is Property => candidate.type === 'Property' && isNamed(candidate.key, candidate.computed, name),
  );
}

function unwrap(node: Node): Node {
  return typeWrappers.has(node.type) ? unwrap((node as Node & { expression: Node }).expression) : node;
}

function isFalse(node: Node): boolean {
  const unwrapped = unwrap(node);

  return unwrapped.type === 'Literal' && unwrapped.value === false;
}

/** Only literals and undefined can be judged; any other expression is taken to be what its author meant. */
function mayShowWindow(node: Node): boolean {
  const unwrapped = unwrap(node);

  return unwrapped.type === 'Literal'
    ? unwrapped.value !== true
    : unwrapped.type === 'Identifier' && unwrapped.name === 'undefined';
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missing: 'Pass windowsHide: true with detached: true; on Windows a detached child opens a console window.',
      assignment:
        'Set windowsHide: true on the same options object as detached; on Windows a detached child opens a console window.',
    },
  },
  create(context) {
    function checkText(node: Literal | TemplateLiteral): void {
      // Each literal is checked alone, so detached and windowsHide must sit in the same string.
      const text = context.sourceCode.getText(node);

      if (detachedInText.test(text) && !windowsHideInText.test(text)) {
        context.report({ node, messageId: 'missing' });
      }
    }

    return {
      ObjectExpression(node) {
        const detached = property(node, 'detached');

        if (detached === undefined || isFalse(detached.value)) {
          return;
        }

        const windowsHide = property(node, 'windowsHide');

        if (windowsHide === undefined) {
          context.report({ node: detached, messageId: 'missing' });

          return;
        }

        if (mayShowWindow(windowsHide.value)) {
          context.report({ node: windowsHide, messageId: 'missing' });

          return;
        }

        const spread = node.properties
          .slice(node.properties.indexOf(windowsHide))
          .find((candidate) => candidate.type === 'SpreadElement');

        if (spread !== undefined) {
          context.report({ node: spread, messageId: 'missing' });
        }
      },
      AssignmentExpression(node) {
        if (
          node.left.type === 'MemberExpression' &&
          isNamed(node.left.property, node.left.computed, 'detached') &&
          !isFalse(node.right)
        ) {
          context.report({ node, messageId: 'assignment' });
        }
      },
      Literal(node) {
        if (typeof node.value === 'string') {
          checkText(node);
        }
      },
      TemplateLiteral: checkText,
    };
  },
};

export default rule;

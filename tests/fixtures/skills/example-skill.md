---
name: example-skill
description: A test skill with multiple sections and code blocks
---

# Example Skill

This is the introductory paragraph that captures the skill's purpose.

## Architecture

The skill follows a layered architecture pattern. Layer 1 handles input,
layer 2 transforms, layer 3 emits.

```typescript
function transform(input: string): string {
  // intentional code block — must not be split
  return input.toUpperCase();
}
```

More architecture prose after the code block.

## Usage

Invoke via the standard skill loader. The skill expects a string input.

### Edge cases

Empty input → empty output. Null input → throws.

## Anti-patterns

Don't bypass layer 2. Don't mutate inputs.

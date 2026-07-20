---
skip: true
---

# Editing the help content

Every file in this directory that is **not** marked `skip: true` becomes one
article in the in-app Help centre. There is no build step and no component to
edit: drop a `.md` file here, give it frontmatter, and it appears.

## Frontmatter

```
---
id: messaging                  # stable slug, used for deep links — do not rename casually
title: Send and format a message
section: Conversations         # groups articles in the sidebar
order: 50                      # sort within the section (and across sections by first article)
summary: One line shown in the list and in search results.
keywords: markdown, edit, react, pin      # extra search terms not in the body
---
```

`id`, `title` and `section` are required. Everything else is optional.

## The rule that matters

**Do not document a feature Stable does not have.** This content is also the
grounding the in-app help agent answers from, so an aspirational sentence here
does not just mislead a reader — it teaches the agent to state it as fact. A
smaller accurate help section beats a large one that lies.

When you ship a feature, add or edit the article in the same change.

---
name: Feature request
about: Suggest an idea or a change to the API
labels: enhancement
---

## What problem are you trying to solve?

<!-- Describe the real situation, not the API you have in mind. "I need X" is
usually easier to satisfy well than "add option Y". -->

## What do you do today instead?

<!-- Workarounds, other libraries, manual backoff, ... -->

## Proposed API (optional)

```ts
// If you have a shape in mind, sketch it here.
```

## Does this fit the project's scope?

`elu-guard` deliberately stays small: in-process adaptive admission control plus
a circuit breaker, one guard per dependency, no dashboards, no distributed
coordination, no storage. Requests that need a broker, a dashboard or global
state are likely out of scope - but tell us about the problem anyway, it may be
solvable within it.

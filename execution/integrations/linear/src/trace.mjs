export function createTrace(name, attributes = {}) {
  return {
    name,
    attributes,
    spans: [],
    annotations: [],
  };
}

export function recordSpan(trace, name, attributes = {}) {
  const span = {
    name,
    attributes,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
  trace.spans.push(span);
  return span;
}

export function addAnnotation(trace, annotation) {
  trace.annotations.push({
    ...annotation,
    createdAt: new Date().toISOString(),
  });
}

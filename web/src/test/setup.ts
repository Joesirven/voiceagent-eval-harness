// jsdom lacks a few browser APIs the shadcn components rely on.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver ??= ResizeObserverStub;
(globalThis as any).IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
Element.prototype.scrollIntoView ??= () => {};
(Element.prototype as any).hasPointerCapture ??= () => false;

import { isTouchEvent } from './predicates';
var ELEMENT_NODE = 1;
export function getNodeClientOffset(node) {
  var el = node.nodeType === ELEMENT_NODE ? node : node.parentElement;

  if (!el) {
    return undefined;
  }

  var _el$getBoundingClient = el.getBoundingClientRect(),
      top = _el$getBoundingClient.top,
      left = _el$getBoundingClient.left;

  return {
    x: left,
    y: top
  };
}
export function getEventClientTouchOffset(e, fallbackTargetTouch) {
  if (e.targetTouches.length === 1) {
    return getEventClientOffset(e.targetTouches[0]);
} else if (e.touches.length === 1) {
    if (e.touches[0].target === fallbackTargetTouch.target) {
        return getEventClientOffset(e.touches[0]);
    }
  }
}
export function getEventClientOffset(e, fallbackTargetTouch) {
  if (isTouchEvent(e)) {
    return getEventClientTouchOffset(e, fallbackTargetTouch);
  } else {
    return {
      x: e.clientX,
      y: e.clientY
    };
  }
}

import invariant from 'invariant';
import { ListenerType } from './interfaces';
import { eventShouldStartDrag, eventShouldEndDrag } from './utils/predicates';
import { getEventClientOffset, getNodeClientOffset } from './utils/offsets';
import { distance, inAngleRanges } from './utils/math';
import supportsPassive from './utils/supportsPassive';
import { OptionsReader } from './OptionsReader';
const eventNames = {
    [ListenerType.mouse]: {
        start: 'mousedown',
        move: 'mousemove',
        end: 'mouseup',
        contextmenu: 'contextmenu',
    },
    [ListenerType.touch]: {
        start: 'touchstart',
        move: 'touchmove',
        end: 'touchend',
    },
    [ListenerType.keyboard]: {
        keydown: 'keydown',
    },
};
export default class TouchBackend {
    constructor(manager, context, options) {
        this.getSourceClientOffset = (sourceId) => {
            return getNodeClientOffset(this.sourceNodes[sourceId]);
        };
        this.handleTopMoveStartCapture = (e) => {
            if (!eventShouldStartDrag(e)) {
                return;
            }
            this.moveStartSourceIds = [];
        };
        this.handleMoveStart = (sourceId) => {
            // Just because we received an event doesn't necessarily mean we need to collect drag sources.
            // We only collect start collecting drag sources on touch and left mouse events.
            if (Array.isArray(this.moveStartSourceIds)) {
                this.moveStartSourceIds.unshift(sourceId);
            }
        };
        this.handleTopMoveStart = (e) => {
            if (!eventShouldStartDrag(e)) {
                return;
            }
            // Don't prematurely preventDefault() here since it might:
            // 1. Mess up scrolling
            // 2. Mess up long tap (which brings up context menu)
            // 3. If there's an anchor link as a child, tap won't be triggered on link
            const clientOffset = getEventClientOffset(e);
            if (clientOffset) {
                this._mouseClientOffset = clientOffset;
            }
            this.waitingForDelay = false;
        };
        this.handleTopMoveStartDelay = (e) => {
            if (!eventShouldStartDrag(e)) {
                return;
            }
            const delay = e.type === eventNames.touch.start
                ? this.options.delayTouchStart
                : this.options.delayMouseStart;
            this.timeout = setTimeout(this.handleTopMoveStart.bind(this, e), delay);
            this.waitingForDelay = true;
        };
        this.handleTopMoveCapture = () => {
            this.dragOverTargetIds = [];
        };
        this.handleMove = (_, targetId) => {
            if (this.dragOverTargetIds) {
                this.dragOverTargetIds.unshift(targetId);
            }
        };
        this.handleTopMove = (e) => {
            if (this.timeout) {
                clearTimeout(this.timeout);
            }
            if (!this.document || this.waitingForDelay) {
                return;
            }
            const { moveStartSourceIds, dragOverTargetIds } = this;
            const enableHoverOutsideTarget = this.options.enableHoverOutsideTarget;
            const clientOffset = getEventClientOffset(e);
            if (!clientOffset) {
                return;
            }
            // If the touch move started as a scroll, or is is between the scroll angles
            if (this._isScrolling ||
                (!this.monitor.isDragging() &&
                    inAngleRanges(this._mouseClientOffset.x || 0, this._mouseClientOffset.y || 0, clientOffset.x, clientOffset.y, this.options.scrollAngleRanges))) {
                this._isScrolling = true;
                return;
            }
            // If we're not dragging and we've moved a little, that counts as a drag start
            if (!this.monitor.isDragging() &&
                // eslint-disable-next-line no-prototype-builtins
                this._mouseClientOffset.hasOwnProperty('x') &&
                moveStartSourceIds &&
                distance(this._mouseClientOffset.x || 0, this._mouseClientOffset.y || 0, clientOffset.x, clientOffset.y) > (this.options.touchSlop ? this.options.touchSlop : 0)) {
                this.moveStartSourceIds = undefined;
                this.actions.beginDrag(moveStartSourceIds, {
                    clientOffset: this._mouseClientOffset,
                    getSourceClientOffset: this.getSourceClientOffset,
                    publishSource: false,
                });
            }
            if (!this.monitor.isDragging()) {
                return;
            }
            const sourceNode = this.sourceNodes[this.monitor.getSourceId()];
            this.installSourceNodeRemovalObserver(sourceNode);
            this.actions.publishDragSource();
            e.preventDefault();
            // Get the node elements of the hovered DropTargets
            const dragOverTargetNodes = (dragOverTargetIds || []).map(key => this.targetNodes[key]);
            // Get the a ordered list of nodes that are touched by
            const elementsAtPoint = this.options.getDropTargetElementsAtPoint
                ? this.options.getDropTargetElementsAtPoint(clientOffset.x, clientOffset.y, dragOverTargetNodes)
                : this.document.elementsFromPoint(clientOffset.x, clientOffset.y);
            // Extend list with parents that are not receiving elementsFromPoint events (size 0 elements and svg groups)
            const elementsAtPointExtended = [];
            for (const nodeId in elementsAtPoint) {
                // eslint-disable-next-line no-prototype-builtins
                if (!elementsAtPoint.hasOwnProperty(nodeId)) {
                    continue;
                }
                let currentNode = elementsAtPoint[nodeId];
                elementsAtPointExtended.push(currentNode);
                while (currentNode) {
                    currentNode = currentNode.parentElement;
                    if (elementsAtPointExtended.indexOf(currentNode) === -1) {
                        elementsAtPointExtended.push(currentNode);
                    }
                }
            }
            const orderedDragOverTargetIds = elementsAtPointExtended
                // Filter off nodes that arent a hovered DropTargets nodes
                .filter(node => dragOverTargetNodes.indexOf(node) > -1)
                // Map back the nodes elements to targetIds
                .map(node => {
                for (const targetId in this.targetNodes) {
                    if (node === this.targetNodes[targetId]) {
                        return targetId;
                    }
                }
                return undefined;
            })
                // Filter off possible null rows
                .filter(node => !!node)
                .filter((id, index, ids) => ids.indexOf(id) === index);
            // Invoke hover for drop targets when source node is still over and pointer is outside
            if (enableHoverOutsideTarget) {
                for (const targetId in this.targetNodes) {
                    if (this.targetNodes[targetId] &&
                        this.targetNodes[targetId].contains(sourceNode) &&
                        orderedDragOverTargetIds.indexOf(targetId) === -1) {
                        orderedDragOverTargetIds.unshift(targetId);
                        break;
                    }
                }
            }
            // Reverse order because dnd-core reverse it before calling the DropTarget drop methods
            orderedDragOverTargetIds.reverse();
            this.actions.hover(orderedDragOverTargetIds, {
                clientOffset: clientOffset,
            });
        };
        this.handleTopMoveEndCapture = (e) => {
            this._isScrolling = false;
            if (!eventShouldEndDrag(e)) {
                return;
            }
            if (!this.monitor.isDragging() || this.monitor.didDrop()) {
                this.moveStartSourceIds = undefined;
                return;
            }
            e.preventDefault();
            this._mouseClientOffset = {};
            this.uninstallSourceNodeRemovalObserver();
            this.actions.drop();
            this.actions.endDrag();
        };
        this.handleCancelOnEscape = (e) => {
            if (e.key === 'Escape' && this.monitor.isDragging()) {
                this._mouseClientOffset = {};
                this.uninstallSourceNodeRemovalObserver();
                this.actions.endDrag();
            }
        };
        this.options = new OptionsReader(options, context);
        this.actions = manager.getActions();
        this.monitor = manager.getMonitor();
        this.sourceNodes = {};
        this.sourcePreviewNodes = {};
        this.sourcePreviewNodeOptions = {};
        this.targetNodes = {};
        this.listenerTypes = [];
        this._mouseClientOffset = {};
        this._isScrolling = false;
        if (this.options.enableMouseEvents) {
            this.listenerTypes.push(ListenerType.mouse);
        }
        if (this.options.enableTouchEvents) {
            this.listenerTypes.push(ListenerType.touch);
        }
        if (this.options.enableKeyboardEvents) {
            this.listenerTypes.push(ListenerType.keyboard);
        }
    }
    // public for test
    get window() {
        return this.options.window;
    }
    // public for test
    get document() {
        if (this.window) {
            return this.window.document;
        }
        return undefined;
    }
    setup() {
        if (!this.window) {
            return;
        }
        invariant(!TouchBackend.isSetUp, 'Cannot have two Touch backends at the same time.');
        TouchBackend.isSetUp = true;
        this.addEventListener(this.window, 'start', this.getTopMoveStartHandler());
        this.addEventListener(this.window, 'start', this.handleTopMoveStartCapture, true);
        this.addEventListener(this.window, 'move', this.handleTopMove);
        this.addEventListener(this.window, 'move', this.handleTopMoveCapture, true);
        this.addEventListener(this.window, 'end', this.handleTopMoveEndCapture, true);
        if (this.options.enableMouseEvents && !this.options.ignoreContextMenu) {
            this.addEventListener(this.window, 'contextmenu', this
                .handleTopMoveEndCapture);
        }
        if (this.options.enableKeyboardEvents) {
            this.addEventListener(this.window, 'keydown', this.handleCancelOnEscape, true);
        }
    }
    teardown() {
        if (!this.window) {
            return;
        }
        TouchBackend.isSetUp = false;
        this._mouseClientOffset = {};
        this.removeEventListener(this.window, 'start', this.handleTopMoveStartCapture, true);
        this.removeEventListener(this.window, 'start', this
            .handleTopMoveStart);
        this.removeEventListener(this.window, 'move', this.handleTopMoveCapture, true);
        this.removeEventListener(this.window, 'move', this.handleTopMove);
        this.removeEventListener(this.window, 'end', this.handleTopMoveEndCapture, true);
        if (this.options.enableMouseEvents && !this.options.ignoreContextMenu) {
            this.removeEventListener(this.window, 'contextmenu', this
                .handleTopMoveEndCapture);
        }
        if (this.options.enableKeyboardEvents) {
            this.removeEventListener(this.window, 'keydown', this.handleCancelOnEscape, true);
        }
        this.uninstallSourceNodeRemovalObserver();
    }
    addEventListener(subject, event, handler, capture) {
        const options = supportsPassive ? { capture, passive: false } : capture;
        this.listenerTypes.forEach(function (listenerType) {
            const evt = eventNames[listenerType][event];
            if (evt) {
                subject.addEventListener(evt, handler, options);
            }
        });
    }
    removeEventListener(subject, event, handler, capture) {
        const options = supportsPassive ? { capture, passive: false } : capture;
        this.listenerTypes.forEach(function (listenerType) {
            const evt = eventNames[listenerType][event];
            if (evt) {
                subject.removeEventListener(evt, handler, options);
            }
        });
    }
    connectDragSource(sourceId, node) {
        const handleMoveStart = this.handleMoveStart.bind(this, sourceId);
        this.sourceNodes[sourceId] = node;
        this.addEventListener(node, 'start', handleMoveStart);
        return () => {
            delete this.sourceNodes[sourceId];
            this.removeEventListener(node, 'start', handleMoveStart);
        };
    }
    connectDragPreview(sourceId, node, options) {
        this.sourcePreviewNodeOptions[sourceId] = options;
        this.sourcePreviewNodes[sourceId] = node;
        return () => {
            delete this.sourcePreviewNodes[sourceId];
            delete this.sourcePreviewNodeOptions[sourceId];
        };
    }
    connectDropTarget(targetId, node) {
        if (!this.document) {
            return () => null;
        }
        const handleMove = (e) => {
            if (!this.document || !this.monitor.isDragging()) {
                return;
            }
            let coords;
            /**
             * Grab the coordinates for the current mouse/touch position
             */
            switch (e.type) {
                case eventNames.mouse.move:
                    coords = {
                        x: e.clientX,
                        y: e.clientY,
                    };
                    break;
                case eventNames.touch.move:
                    coords = {
                        x: e.touches[0].clientX,
                        y: e.touches[0].clientY,
                    };
                    break;
            }
            /**
             * Use the coordinates to grab the element the drag ended on.
             * If the element is the same as the target node (or any of it's children) then we have hit a drop target and can handle the move.
             */
            const droppedOn = coords != null
                ? this.document.elementFromPoint(coords.x, coords.y)
                : undefined;
            const childMatch = droppedOn && node.contains(droppedOn);
            if (droppedOn === node || childMatch) {
                return this.handleMove(e, targetId);
            }
        };
        /**
         * Attaching the event listener to the body so that touchmove will work while dragging over multiple target elements.
         */
        this.addEventListener(this.document.body, 'move', handleMove);
        this.targetNodes[targetId] = node;
        return () => {
            if (this.document) {
                delete this.targetNodes[targetId];
                this.removeEventListener(this.document.body, 'move', handleMove);
            }
        };
    }
    getTopMoveStartHandler() {
        if (!this.options.delayTouchStart && !this.options.delayMouseStart) {
            return this.handleTopMoveStart;
        }
        return this.handleTopMoveStartDelay;
    }
    installSourceNodeRemovalObserver(node) {
        this.uninstallSourceNodeRemovalObserver();
        this.draggedSourceNode = node;
        this.draggedSourceNodeRemovalObserver = new MutationObserver(() => {
            if (node && !node.parentElement) {
                this.resurrectSourceNode();
                this.uninstallSourceNodeRemovalObserver();
            }
        });
        if (!node || !node.parentElement) {
            return;
        }
        this.draggedSourceNodeRemovalObserver.observe(node.parentElement, {
            childList: true,
        });
    }
    resurrectSourceNode() {
        if (this.document && this.draggedSourceNode) {
            this.draggedSourceNode.style.display = 'none';
            this.draggedSourceNode.removeAttribute('data-reactid');
            this.document.body.appendChild(this.draggedSourceNode);
        }
    }
    uninstallSourceNodeRemovalObserver() {
        if (this.draggedSourceNodeRemovalObserver) {
            this.draggedSourceNodeRemovalObserver.disconnect();
        }
        this.draggedSourceNodeRemovalObserver = undefined;
        this.draggedSourceNode = undefined;
    }
}

// Types
type WidgetActionIntent = 'click' | 'eat' | 'equip' | 'drink' | 'use';

// resolveChild()
export const resolveChild = (
    parentWidget: any,
    slot: number
) => () => {
    if (!widgetExists(parentWidget)) return null;
    const childData = titan.state.widgets.children(parentWidget.packedId)[slot];
    if (!childData) return null;
    return {
        exists: !!childData.exists,
        interact: (
            opcode: number,
            identifier: number = 1
        ) => {
            if (typeof parentWidget.interact !== 'function') return false;
            return parentWidget.interact(opcode, identifier, slot);
        }
    };
};

// widgetExists()
export const widgetExists = (widget: any) => widget && widget.visible !== false && widget.exists;

// interactWidget()
export const interactWidget = (
    widget: any,
    intent: WidgetActionIntent | number = 'click',
    identifier: number = 1,
    childSlot?: number
) => {
    if (!widgetExists(widget)) return false;
    const opcode = typeof intent === 'number' ? intent : resolveOpcodeForIntent(intent);
    return childSlot !== undefined ? widget.interact(opcode, identifier, childSlot) : widget.interact(opcode, identifier);
};

// resolveOpcodeForIntent()
const resolveOpcodeForIntent = (intent: WidgetActionIntent): number => {
    switch (intent) {
        case 'click':
            return titan.MenuAction.CC_OP;
        case 'eat':
        case 'equip':
        case 'drink':
            return titan.MenuAction.CC_OP_LOW_PRIORITY;
        default:
            return titan.MenuAction.CC_OP;
    }
};
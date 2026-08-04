export const debug = {
    widgets: (event: any) => {
        titan.logf(
            "opcode [%i], identifier [%i], param0 [%i], param1 [%i]",
            event.opcode, event.identifier, event.param0, event.param1
        );
    }
}
/// <reference path="./titan-plugin-sdk.d.ts" />
import { debug } from './general/debug.js';
import { variables } from './general/variables.js';

class StarkMercher extends titan.Plugin {
    id = "stark-mercher";
    name = "Stark Mercher";
    onGameTick = (tick: number) => gameTick(tick);
    onMenuOptionClicked(event: any) {
        debug.widgets(event);
    }
}
titan.register(new StarkMercher());

const gameTick = (tick: number) => {
    if (variables.timeout > 0) {
        variables.timeout--;
        return;
    }
};
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

let test121 = false;

// onGameTick()
const gameTick = (tick: number) => {
    // titan.log(`TICK: ${tick.toString()}`);
    if (variables.timeout > 0) {
        variables.timeout--;
        return;
    }

    // try {
    //     randomAfk();
    //     retrieveFlippableItems();
    //     retrieveOneHourData();
    //     getOfferData();
    stateManager();
    // } catch (error) {
    //     debug.both('Script', (error as Error).toString());
    // }
};

const stateManager = () => {
    if (!test121) {
        const geSlot1BuyOffer = titan.state.widgets.find(30474247);
        if (geSlot1BuyOffer) {
            geSlot1BuyOffer.interact(57, 1);
        }
        test121 = true;
    }
};
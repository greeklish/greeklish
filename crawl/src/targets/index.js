import {
  runTarget as runInsomniaTopics,
  target as insomniaTopics,
} from "./insomnia-topics.js";
import {
  runTarget as runMyphoneTopics,
  target as myphoneTopics,
} from "./myphone-topics.js";
import {
  runTarget as runPhorumTopics,
  target as phorumTopics,
} from "./phorum-topics.js";
import {
  runTarget as runAdslgrTopics,
  target as adslgrTopics,
} from "./adslgr-topics.js";
import {
  runTarget as runRGreeceRising,
  target as rGreeceRising,
} from "./r-greece-rising.js";
import {
  runTarget as runXTrends,
  target as xTrends,
} from "./x-trends.js";
import {
  runTarget as runLagonikaOffers,
  target as lagonikaOffers,
} from "./lagonika-offers.js";

const targets = new Map([
  [
    rGreeceRising.name,
    { definition: rGreeceRising, run: runRGreeceRising },
  ],
  [
    xTrends.name,
    { definition: xTrends, run: runXTrends },
  ],
  [
    insomniaTopics.name,
    { definition: insomniaTopics, run: runInsomniaTopics },
  ],
  [
    myphoneTopics.name,
    { definition: myphoneTopics, run: runMyphoneTopics },
  ],
  [
    phorumTopics.name,
    { definition: phorumTopics, run: runPhorumTopics },
  ],
  [
    adslgrTopics.name,
    { definition: adslgrTopics, run: runAdslgrTopics },
  ],
  [
    lagonikaOffers.name,
    { definition: lagonikaOffers, run: runLagonikaOffers },
  ],
]);

export function listTargets() {
  return Array.from(targets.values()).map(({ definition }) => definition);
}

export function getTarget(name) {
  return targets.get(name) || null;
}

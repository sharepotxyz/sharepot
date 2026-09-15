// "How it works" page: static text plus the demo video; only the shared top bar is live.
import { fetchMarkets } from "./chain";
import { loadStocks } from "./stocks";
import { mountTopbar, trackStocks } from "./ui";
mountTopbar({});
Promise.all([fetchMarkets(), loadStocks()]).then(([ms]) => trackStocks(ms)).catch(() => {});

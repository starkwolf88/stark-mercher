// --- Pricing thresholds ----------------------------------------------------
const BULK_QTY_THRESHOLD = 500;
const BULK_MARKUP = 1.2;
const MULTI_QTY_THRESHOLD = 10;
const MULTI_MARKUP = 1.5;

// targetPrice()
// Calculates a buy price with markup based on quantity and market price.
// - Bulk (>= 500 qty): 1.2x market price
// - Multi (> 10 qty):  1.5x market price
// - Small qty: flat minimums to ensure the offer fills quickly
export const targetPrice = (marketPrice: number, qty: number): number => {
    if (qty >= BULK_QTY_THRESHOLD) return Math.ceil(marketPrice * BULK_MARKUP);
    if (qty > MULTI_QTY_THRESHOLD) return Math.ceil(marketPrice * MULTI_MARKUP);
    if (marketPrice < 1000) return 5000;
    if (marketPrice < 5000) return 10000;
    if (marketPrice < 10000) return 20000;
    if (marketPrice < 20000) return 30000;
    return Math.ceil(marketPrice * BULK_MARKUP);
};

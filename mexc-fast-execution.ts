import crypto from "crypto";
import {
  FastDirection,
  FastExecution,
  FastExecutionPositionIntent,
  FastExecutionPreflight,
  FastExecutionResult,
  FastProtectionResult,
  FastRecoveredOrder,
  FastVenuePosition,
} from "./fast-trend-execution";
import {
  calculateMexcContracts,
  MexcContractInfo,
  MexcFutures,
  MexcOrder,
  MexcPosition,
} from "./mexc-futures";
import { ExitFillAudit, computeExitFillAudit } from "./exit-fill-audit";

export interface MexcFastConfig {
  riskPct: number;
  maxPortfolioRiskPct: number;
  leverage: number;
  marginType: "ISOLATED" | "CROSSED";
  maxBasisPct: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** MEXC externalOid is capped at 32 chars. */
export function makeMexcExternalOid(operationKey: string): string {
  return `ft${crypto.createHash("sha256").update(operationKey).digest("hex").slice(0, 30)}`;
}

const sideToOpen = (dir: FastDirection): 1 | 3 => (dir === "long" ? 1 : 3);
// One-way mode uses buy/sell direction plus reduceOnly; side 2/4 are Hedge-mode close directions.
const sideToReduce = (dir: FastDirection): 1 | 3 => (dir === "long" ? 3 : 1);

export class MexcFastExecution implements FastExecution {
  readonly venueLabel = "MEXC";

  constructor(private readonly api: MexcFutures, private readonly cfg: MexcFastConfig) {}

  private openType(): 1 | 2 {
    return this.cfg.marginType === "CROSSED" ? 2 : 1;
  }

  private contractEligible(contract: MexcContractInfo): string[] {
    const errors: string[] = [];
    if (contract.contractType !== 1) errors.push(`${contract.symbol}: contract type=${contract.contractType}`);
    if (contract.state !== 0) errors.push(`${contract.symbol}: contract state=${contract.state}`);
    if (!contract.apiAllowed) errors.push(`${contract.symbol}: apiAllowed=false`);
    if (contract.futureType !== 1 || contract.quoteCoin !== "USDT") {
      errors.push(`${contract.symbol}: không phải USDT perpetual`);
    }
    if (contract.appraisal === 1) errors.push(`${contract.symbol}: thuộc Assessment Zone`);
    const mode = this.openType();
    if (![mode, 3].includes(contract.positionOpenType)) {
      errors.push(`${contract.symbol}: không hỗ trợ ${mode === 1 ? "isolated" : "cross"}`);
    }
    const countryMax = contract.countryConfigContractMaxLeverage > 0
      ? contract.countryConfigContractMaxLeverage
      : contract.maxLeverage;
    if (this.cfg.leverage < contract.minLeverage || this.cfg.leverage > Math.min(contract.maxLeverage, countryMax)) {
      errors.push(`${contract.symbol}: leverage ${this.cfg.leverage}x ngoài giới hạn`);
    }
    if (!(contract.contractSize > 0 && contract.volUnit > 0 && contract.priceUnit > 0)) {
      errors.push(`${contract.symbol}: metadata sizing không hợp lệ`);
    }
    return errors;
  }

  async preflight(symbols: string[]): Promise<FastExecutionPreflight> {
    const warnings: string[] = [];
    const errors: string[] = [];
    await this.api.syncTime();
    await this.api.loadContracts(symbols);
    for (const symbol of symbols) errors.push(...this.contractEligible(this.api.getContract(symbol)));

    const asset = await this.api.getEquity();
    if (!(asset.equity > 0)) errors.push("MEXC Futures USDT equity = 0");
    if (!(asset.availableOpen >= 0)) errors.push("MEXC availableOpen không hợp lệ");

    try {
      const positionMode = await this.api.getPositionMode();
      if (positionMode !== 2) errors.push("MEXC đang Hedge mode; Fast Trend yêu cầu One-way mode");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    const positions = await this.api.getOpenPositions();
    if (positions.length) {
      warnings.push(`MEXC đang có ${positions.length} vị thế; Fast sẽ đối soát ownership từng symbol`);
    }
    return { ok: errors.length === 0, equity: asset.equity, warnings, errors };
  }

  private async reference(symbol: string, signalEntry: number): Promise<{ price: number; basis: number }> {
    const ticker = await this.api.getTicker(symbol);
    if (!(ticker.lastPrice > 0)) throw new Error(`${symbol}: MEXC ticker không hợp lệ`);
    const basis = Math.abs(ticker.lastPrice / signalEntry - 1);
    return { price: ticker.lastPrice, basis };
  }

  private venueStop(
    symbol: string,
    dir: FastDirection,
    venueEntry: number,
    signalEntry: number,
    signalStop: number,
  ): number {
    const riskFraction = Math.abs(signalEntry - signalStop) / signalEntry;
    const raw = dir === "long" ? venueEntry * (1 - riskFraction) : venueEntry * (1 + riskFraction);
    return this.api.roundStop(symbol, raw, dir);
  }

  private size(
    symbol: string,
    riskUsd: number,
    entry: number,
    stop: number,
  ): ReturnType<typeof calculateMexcContracts> {
    return calculateMexcContracts(this.api.getContract(symbol), riskUsd, entry, stop);
  }

  private validFill(order: MexcOrder): boolean {
    return order.state === 3 && order.dealVol > 0 && order.dealAvgPrice > 0;
  }

  private stopCoversPosition(stop: Awaited<ReturnType<MexcFutures["getOpenStopOrders"]>>[number], position: MexcPosition): boolean {
    // MEXC returns vol=realityVol=0 for volType=2 (position-wide TP/SL).
    return (
      stop.errorCode === 0 &&
      stop.positionType === position.positionType &&
      (stop.volType === 2 || Math.max(stop.vol, stop.realityVol) >= position.holdVol)
    );
  }

  private async waitPosition(symbol: string, positionId?: string): Promise<MexcPosition> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const position = await this.api.getOpenPosition(symbol);
      if (position && (!positionId || position.positionId === positionId)) return position;
      await sleep(300);
    }
    throw new Error(`${symbol}: order đã fill nhưng chưa thấy MEXC position`);
  }

  private async verifyStop(
    symbol: string,
    position: MexcPosition,
    protectionId: string,
    stopPrice: number,
  ): Promise<FastProtectionResult> {
    const tick = this.api.getContract(symbol).priceUnit;
    for (let attempt = 0; attempt < 8; attempt++) {
      const stops = (await this.api.getOpenStopOrders(symbol)).filter(
        (stop) => stop.positionId === position.positionId && stop.state === 1 && stop.isFinished === 0,
      );
      const stop = stops.find((item) => item.id === protectionId);
      if (
        stop &&
        Math.abs(stop.stopLossPrice - stopPrice) <= tick / 2 + 1e-12 &&
        this.stopCoversPosition(stop, position)
      ) {
        return { protectionId: stop.id, stopPrice: stop.stopLossPrice };
      }
      await sleep(300);
    }
    throw new Error(`${symbol}: không xác minh được native stop MEXC phủ toàn vị thế`);
  }

  private async createAndVerifyStop(
    symbol: string,
    position: MexcPosition,
    stopPrice: number,
  ): Promise<FastProtectionResult> {
    const protectionId = await this.api.placePositionStop(position, stopPrice);
    return this.verifyStop(symbol, position, protectionId, stopPrice);
  }

  async open(
    symbol: string,
    intent: FastExecutionPositionIntent,
    openRiskFrac: number,
    operationKey: string,
    maxRiskFrac: number,
  ): Promise<FastExecutionResult> {
    if (openRiskFrac + this.cfg.riskPct > this.cfg.maxPortfolioRiskPct + 1e-9) {
      return { placed: false, reason: "chạm trần risk MEXC" };
    }
    const asset = await this.api.getEquity();
    const ref = await this.reference(symbol, intent.signalEntry);
    if (ref.basis > this.cfg.maxBasisPct) {
      return {
        placed: false,
        reason: `basis Binance/MEXC ${(ref.basis * 100).toFixed(2)}% > ${(this.cfg.maxBasisPct * 100).toFixed(2)}%`,
      };
    }
    const plannedStop = this.venueStop(symbol, intent.dir, ref.price, intent.signalEntry, intent.initialSL);
    const requestedRiskUsd = asset.equity * this.cfg.riskPct;
    const sized = this.size(symbol, requestedRiskUsd, ref.price, plannedStop);
    if (!(sized.contracts > 0)) return { placed: false, reason: "equity quá nhỏ cho min contract MEXC" };
    const effectiveRiskFrac = sized.actualRiskUsd / asset.equity;
    if (effectiveRiskFrac > maxRiskFrac + 1e-9) {
      return { placed: false, reason: "min contract MEXC vượt ngân sách risk vị thế" };
    }

    const order = await this.api.createMarketOrder({
      symbol,
      price: ref.price,
      contracts: sized.contracts,
      leverage: this.cfg.leverage,
      side: sideToOpen(intent.dir),
      openType: this.openType(),
      externalOid: makeMexcExternalOid(operationKey),
    });
    if (!this.validFill(order)) {
      if ([4, 5].includes(order.state)) return { placed: false, reason: `MEXC order state=${order.state}` };
      throw new Error(`${symbol}: MEXC entry outcome chưa xác định (state=${order.state})`);
    }

    const position = await this.waitPosition(symbol, order.positionId);
    const confirmedStop = this.venueStop(
      symbol,
      intent.dir,
      order.dealAvgPrice,
      intent.signalEntry,
      intent.initialSL,
    );
    let protection: FastProtectionResult;
    try {
      protection = await this.createAndVerifyStop(symbol, position, confirmedStop);
    } catch (error) {
      // A filled position may never be returned as successful while naked.
      try {
        await this.flatten(symbol, intent.dir, `${operationKey}:emergency-close`);
      } catch (closeError) {
        throw new Error(
          `${symbol}: native stop MEXC chưa xác minh (${error instanceof Error ? error.message : error}); ` +
          `đóng khẩn cấp thất bại (${closeError instanceof Error ? closeError.message : closeError})`,
        );
      }
      return {
        placed: false,
        reason: `native stop MEXC thất bại; đã đóng khẩn cấp (${error instanceof Error ? error.message : error})`,
      };
    }

    const riskUsd = order.dealVol * this.api.getContract(symbol).contractSize * Math.abs(order.dealAvgPrice - confirmedStop);
    return {
      placed: true,
      qty: order.dealVol,
      avgPrice: order.dealAvgPrice,
      riskUsd,
      equity: asset.equity,
      positionId: position.positionId,
      protectionId: protection.protectionId,
      venueScale: order.dealAvgPrice / intent.signalEntry,
      confirmedVenueSl: protection.stopPrice,
    };
  }

  async add(
    symbol: string,
    intent: FastExecutionPositionIntent,
    openRiskFrac: number,
    currentPositionRiskFrac: number,
    operationKey: string,
    maxPositionRiskFrac: number,
  ): Promise<FastExecutionResult> {
    const asset = await this.api.getEquity();
    const ref = await this.reference(symbol, intent.signalEntry);
    if (ref.basis > this.cfg.maxBasisPct) {
      return { placed: false, reason: `basis ${(ref.basis * 100).toFixed(2)}% vượt gate` };
    }
    const plannedStop = this.venueStop(symbol, intent.dir, ref.price, intent.signalEntry, intent.initialSL);
    const sized = this.size(symbol, asset.equity * this.cfg.riskPct, ref.price, plannedStop);
    if (!(sized.contracts > 0)) return { placed: false, reason: "equity quá nhỏ cho min contract MEXC" };
    const effectiveRiskFrac = sized.actualRiskUsd / asset.equity;
    if (currentPositionRiskFrac + effectiveRiskFrac > maxPositionRiskFrac + 1e-9) {
      return { placed: false, reason: "vị thế đã dùng hết ngân sách risk" };
    }
    if (openRiskFrac + effectiveRiskFrac > this.cfg.maxPortfolioRiskPct + 1e-9) {
      return { placed: false, reason: "chạm trần risk MEXC" };
    }

    const order = await this.api.createMarketOrder({
      symbol,
      price: ref.price,
      contracts: sized.contracts,
      leverage: this.cfg.leverage,
      side: sideToOpen(intent.dir),
      openType: this.openType(),
      externalOid: makeMexcExternalOid(operationKey),
    });
    if (!this.validFill(order)) {
      if ([4, 5].includes(order.state)) return { placed: false, reason: `MEXC add state=${order.state}` };
      throw new Error(`${symbol}: MEXC add outcome chưa xác định (state=${order.state})`);
    }
    const position = await this.waitPosition(symbol, order.positionId ?? intent.positionId);
    const riskUsd = order.dealVol * this.api.getContract(symbol).contractSize * Math.abs(order.dealAvgPrice - plannedStop);
    return {
      placed: true,
      qty: order.dealVol,
      avgPrice: order.dealAvgPrice,
      riskUsd,
      equity: asset.equity,
      positionId: position.positionId,
    };
  }

  async syncStops(symbol: string, intent: FastExecutionPositionIntent): Promise<FastProtectionResult> {
    const position = await this.api.getOpenPosition(symbol);
    if (!position) throw new Error(`${symbol}: không có MEXC position để đồng bộ stop`);
    if (intent.positionId && position.positionId !== intent.positionId) {
      throw new Error(`${symbol}: positionId MEXC không khớp ownership`);
    }
    const scale = intent.venueScale ?? position.holdAvgPrice / intent.signalEntry;
    const stopPrice = this.api.roundStop(symbol, intent.signalStop * scale, intent.dir);
    const active = (await this.api.getOpenStopOrders(symbol)).filter(
      (stop) => stop.positionId === position.positionId && stop.state === 1 && stop.isFinished === 0,
    );
    if (active.length > 1) throw new Error(`${symbol}: có ${active.length} stop MEXC; quarantine để kiểm tra ownership`);

    if (active.length === 0) return this.createAndVerifyStop(symbol, position, stopPrice);
    const current = active[0];
    if (intent.protectionId && current.id !== intent.protectionId) {
      throw new Error(`${symbol}: stop MEXC hiện tại không khớp protectionId đã lưu`);
    }
    if (current.stopLossPrice !== stopPrice) {
      try {
        await this.api.modifyStopPrice(current.id, stopPrice);
      } catch {
        // The POST may have been accepted before the connection failed; read-back decides outcome.
      }
      let priceConfirmed = false;
      const tick = this.api.getContract(symbol).priceUnit;
      for (let attempt = 0; attempt < 8; attempt++) {
        const refreshed = (await this.api.getOpenStopOrders(symbol)).find((stop) => stop.id === current.id);
        if (refreshed && Math.abs(refreshed.stopLossPrice - stopPrice) <= tick / 2 + 1e-12) {
          priceConfirmed = true;
          break;
        }
        await sleep(300);
      }
      if (!priceConfirmed) throw new Error(`${symbol}: MEXC chưa xác nhận giá stop mới`);
    }
    if (!this.stopCoversPosition(current, position)) {
      // Submitting the same price updates full-position volume asynchronously per MEXC docs.
      try {
        const updatedId = await this.api.placePositionStop(position, stopPrice);
        if (updatedId !== current.id) {
          throw new Error(`${symbol}: MEXC tạo stop ID mới thay vì cập nhật stop owned`);
        }
      } catch {
        // Verify below; ambiguous TP/SL writes have no externalOid and must not be repeated blindly.
      }
    }
    return this.verifyStop(symbol, position, current.id, stopPrice);
  }

  async flatten(symbol: string, dir: FastDirection, operationKey: string): Promise<void> {
    const position = await this.api.getOpenPosition(symbol);
    if (!position) return;
    const ticker = await this.api.getTicker(symbol);
    const order = await this.api.createMarketOrder({
      symbol,
      price: ticker.lastPrice,
      contracts: position.holdVol,
      leverage: position.leverage || this.cfg.leverage,
      side: sideToReduce(dir),
      openType: position.openType,
      externalOid: makeMexcExternalOid(operationKey),
      positionId: position.positionId,
      reduceOnly: true,
    });
    if (!this.validFill(order) && ![4, 5].includes(order.state)) {
      throw new Error(`${symbol}: MEXC exit outcome chưa xác định (state=${order.state})`);
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!(await this.api.getOpenPosition(symbol))) {
        const stops = (await this.api.getOpenStopOrders(symbol)).filter((s) => s.positionId === position.positionId);
        for (const stop of stops) await this.api.cancelStop(stop.id);
        return;
      }
      await sleep(300);
    }
    throw new Error(`${symbol}: MEXC exit chưa xác nhận flat`);
  }

  /**
   * CHỈ ĐỌC — đo trượt giá thật ở chiều thoát (xem exit-fill-audit.ts). Không gửi lệnh, không đổi state.
   * `positionId` là vị thế vừa đóng; nếu không truyền thì lấy bản ghi đóng gần nhất của symbol.
   * Trả `null` khi không đọc được — người gọi phải coi phép đo là tuỳ chọn.
   */
  async realizedExit(
    symbol: string,
    dir: FastDirection,
    assumedExit: number,
    positionId?: number,
    atrNow?: number
  ): Promise<ExitFillAudit | null> {
    try {
      const hist = await this.api.getHistoryPositions(symbol);
      const rec = positionId != null
        ? hist.find((p) => p.positionId === positionId)
        : hist.sort((a, b) => b.updateTime - a.updateTime)[0];
      if (!rec || !(rec.closeAvgPrice > 0) || !(rec.closeVol > 0)) return null;
      return computeExitFillAudit({
        venue: "mexc",
        dir,
        assumedExit,
        fills: [{ price: rec.closeAvgPrice, qty: rec.closeVol, realizedUsd: rec.realised }],
        atrNow,
      });
    } catch {
      return null; // phép đo không bao giờ được làm hỏng việc thoát lệnh
    }
  }

  async reconcile(symbol: string): Promise<FastVenuePosition> {
    const position = await this.api.getOpenPosition(symbol);
    if (!position) return { positionAmt: 0, entryPrice: 0, markPrice: 0 };
    const ticker = await this.api.getTicker(symbol);
    return {
      positionAmt: position.positionType === 1 ? position.holdVol : -position.holdVol,
      entryPrice: position.holdAvgPrice,
      markPrice: ticker.fairPrice || ticker.lastPrice,
      positionId: position.positionId,
    };
  }

  async recoverOrder(symbol: string, operationKey: string): Promise<FastRecoveredOrder | null> {
    const order = await this.api.tryGetOrderByExternalId(symbol, makeMexcExternalOid(operationKey));
    if (!order || !this.validFill(order)) return null;
    return {
      filledQty: order.dealVol,
      avgPrice: order.dealAvgPrice,
      positionId: order.positionId,
    };
  }

  syncTime(): Promise<void> {
    return this.api.syncTime();
  }
}

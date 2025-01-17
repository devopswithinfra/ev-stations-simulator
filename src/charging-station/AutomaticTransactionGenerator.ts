// Partial Copyright Jerome Benoit. 2021-2023. All Rights Reserved.

import { hoursToMilliseconds, secondsToMilliseconds } from 'date-fns'

import type { ChargingStation } from './ChargingStation.js'
import { checkChargingStation } from './Helpers.js'
import { IdTagsCache } from './IdTagsCache.js'
import { isIdTagAuthorized } from './ocpp/index.js'
import { BaseError } from '../exception/index.js'
import { PerformanceStatistics } from '../performance/index.js'
import {
  AuthorizationStatus,
  RequestCommand,
  type StartTransactionRequest,
  type StartTransactionResponse,
  type Status,
  StopTransactionReason,
  type StopTransactionResponse
} from '../types/index.js'
import {
  Constants,
  cloneObject,
  convertToDate,
  formatDurationMilliSeconds,
  getRandomInteger,
  isValidTime,
  logPrefix,
  logger,
  secureRandom,
  sleep
} from '../utils/index.js'

export class AutomaticTransactionGenerator {
  private static readonly instances: Map<string, AutomaticTransactionGenerator> = new Map<
  string,
  AutomaticTransactionGenerator
  >()

  public readonly connectorsStatus: Map<number, Status>
  public started: boolean
  private starting: boolean
  private stopping: boolean
  private readonly chargingStation: ChargingStation

  private constructor (chargingStation: ChargingStation) {
    this.started = false
    this.starting = false
    this.stopping = false
    this.chargingStation = chargingStation
    this.connectorsStatus = new Map<number, Status>()
    this.initializeConnectorsStatus()
  }

  public static getInstance (
    chargingStation: ChargingStation
  ): AutomaticTransactionGenerator | undefined {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (!AutomaticTransactionGenerator.instances.has(chargingStation.stationInfo!.hashId)) {
      AutomaticTransactionGenerator.instances.set(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        chargingStation.stationInfo!.hashId,
        new AutomaticTransactionGenerator(chargingStation)
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return AutomaticTransactionGenerator.instances.get(chargingStation.stationInfo!.hashId)
  }

  public start (): void {
    if (!checkChargingStation(this.chargingStation, this.logPrefix())) {
      return
    }
    if (this.started) {
      logger.warn(`${this.logPrefix()} is already started`)
      return
    }
    if (this.starting) {
      logger.warn(`${this.logPrefix()} is already starting`)
      return
    }
    this.starting = true
    this.startConnectors()
    this.started = true
    this.starting = false
  }

  public stop (): void {
    if (!this.started) {
      logger.warn(`${this.logPrefix()} is already stopped`)
      return
    }
    if (this.stopping) {
      logger.warn(`${this.logPrefix()} is already stopping`)
      return
    }
    this.stopping = true
    this.stopConnectors()
    this.started = false
    this.stopping = false
  }

  public startConnector (connectorId: number): void {
    if (!checkChargingStation(this.chargingStation, this.logPrefix(connectorId))) {
      return
    }
    if (!this.connectorsStatus.has(connectorId)) {
      logger.error(`${this.logPrefix(connectorId)} starting on non existing connector`)
      throw new BaseError(`Connector ${connectorId} does not exist`)
    }
    if (this.connectorsStatus.get(connectorId)?.start === false) {
      this.internalStartConnector(connectorId).catch(Constants.EMPTY_FUNCTION)
    } else if (this.connectorsStatus.get(connectorId)?.start === true) {
      logger.warn(`${this.logPrefix(connectorId)} is already started on connector`)
    }
  }

  public stopConnector (connectorId: number): void {
    if (!this.connectorsStatus.has(connectorId)) {
      logger.error(`${this.logPrefix(connectorId)} stopping on non existing connector`)
      throw new BaseError(`Connector ${connectorId} does not exist`)
    }
    if (this.connectorsStatus.get(connectorId)?.start === true) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.connectorsStatus.get(connectorId)!.start = false
    } else if (this.connectorsStatus.get(connectorId)?.start === false) {
      logger.warn(`${this.logPrefix(connectorId)} is already stopped on connector`)
    }
  }

  private startConnectors (): void {
    if (
      this.connectorsStatus.size > 0 &&
      this.connectorsStatus.size !== this.chargingStation.getNumberOfConnectors()
    ) {
      this.connectorsStatus.clear()
      this.initializeConnectorsStatus()
    }
    if (this.chargingStation.hasEvses) {
      for (const [evseId, evseStatus] of this.chargingStation.evses) {
        if (evseId > 0) {
          for (const connectorId of evseStatus.connectors.keys()) {
            this.startConnector(connectorId)
          }
        }
      }
    } else {
      for (const connectorId of this.chargingStation.connectors.keys()) {
        if (connectorId > 0) {
          this.startConnector(connectorId)
        }
      }
    }
  }

  private stopConnectors (): void {
    if (this.chargingStation.hasEvses) {
      for (const [evseId, evseStatus] of this.chargingStation.evses) {
        if (evseId > 0) {
          for (const connectorId of evseStatus.connectors.keys()) {
            this.stopConnector(connectorId)
          }
        }
      }
    } else {
      for (const connectorId of this.chargingStation.connectors.keys()) {
        if (connectorId > 0) {
          this.stopConnector(connectorId)
        }
      }
    }
  }

  private async internalStartConnector (connectorId: number): Promise<void> {
    this.setStartConnectorStatus(connectorId)
    logger.info(
      `${this.logPrefix(
        connectorId
      )} started on connector and will run for ${formatDurationMilliSeconds(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.connectorsStatus.get(connectorId)!.stopDate!.getTime() -
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          this.connectorsStatus.get(connectorId)!.startDate!.getTime()
      )}`
    )
    while (this.connectorsStatus.get(connectorId)?.start === true) {
      await this.waitChargingStationAvailable(connectorId)
      await this.waitConnectorAvailable(connectorId)
      if (!this.canStartConnector(connectorId)) {
        this.stopConnector(connectorId)
        break
      }
      const wait = secondsToMilliseconds(
        getRandomInteger(
          this.chargingStation.getAutomaticTransactionGeneratorConfiguration()
            ?.maxDelayBetweenTwoTransactions,
          this.chargingStation.getAutomaticTransactionGeneratorConfiguration()
            ?.minDelayBetweenTwoTransactions
        )
      )
      logger.info(`${this.logPrefix(connectorId)} waiting for ${formatDurationMilliSeconds(wait)}`)
      await sleep(wait)
      const start = secureRandom()
      if (
        start <
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.chargingStation.getAutomaticTransactionGeneratorConfiguration()!.probabilityOfStart
      ) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.connectorsStatus.get(connectorId)!.skippedConsecutiveTransactions = 0
        // Start transaction
        const startResponse = await this.startTransaction(connectorId)
        if (startResponse?.idTagInfo.status === AuthorizationStatus.ACCEPTED) {
          // Wait until end of transaction
          const waitTrxEnd = secondsToMilliseconds(
            getRandomInteger(
              this.chargingStation.getAutomaticTransactionGeneratorConfiguration()?.maxDuration,
              this.chargingStation.getAutomaticTransactionGeneratorConfiguration()?.minDuration
            )
          )
          logger.info(
            `${this.logPrefix(
              connectorId
            )} transaction started with id ${this.chargingStation.getConnectorStatus(connectorId)
              ?.transactionId} and will stop in ${formatDurationMilliSeconds(waitTrxEnd)}`
          )
          await sleep(waitTrxEnd)
          await this.stopTransaction(connectorId)
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ++this.connectorsStatus.get(connectorId)!.skippedConsecutiveTransactions
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ++this.connectorsStatus.get(connectorId)!.skippedTransactions
        logger.info(
          `${this.logPrefix(connectorId)} skipped consecutively ${this.connectorsStatus.get(
            connectorId
          )?.skippedConsecutiveTransactions}/${this.connectorsStatus.get(connectorId)
            ?.skippedTransactions} transaction(s)`
        )
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.connectorsStatus.get(connectorId)!.lastRunDate = new Date()
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.connectorsStatus.get(connectorId)!.stoppedDate = new Date()
    logger.info(
      `${this.logPrefix(
        connectorId
      )} stopped on connector and lasted for ${formatDurationMilliSeconds(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.connectorsStatus.get(connectorId)!.stoppedDate!.getTime() -
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          this.connectorsStatus.get(connectorId)!.startDate!.getTime()
      )}`
    )
    logger.debug(
      `${this.logPrefix(connectorId)} connector status: %j`,
      this.connectorsStatus.get(connectorId)
    )
  }

  private setStartConnectorStatus (connectorId: number): void {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.connectorsStatus.get(connectorId)!.startDate = new Date()
    if (
      this.chargingStation.getAutomaticTransactionGeneratorConfiguration()?.stopAbsoluteDuration ===
        false ||
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      !isValidTime(this.connectorsStatus.get(connectorId)!.stopDate)
    ) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.connectorsStatus.get(connectorId)!.stopDate = new Date(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.connectorsStatus.get(connectorId)!.startDate!.getTime() +
          hoursToMilliseconds(
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.chargingStation.getAutomaticTransactionGeneratorConfiguration()!.stopAfterHours
          )
      )
    }
    delete this.connectorsStatus.get(connectorId)?.stoppedDate
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.connectorsStatus.get(connectorId)!.skippedConsecutiveTransactions = 0
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.connectorsStatus.get(connectorId)!.start = true
  }

  private canStartConnector (connectorId: number): boolean {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (new Date() > this.connectorsStatus.get(connectorId)!.stopDate!) {
      logger.info(
        `${this.logPrefix(
          connectorId
        )} entered in transaction loop while the ATG stop date has been reached`
      )
      return false
    }
    if (!this.chargingStation.inAcceptedState()) {
      logger.error(
        `${this.logPrefix(
          connectorId
        )} entered in transaction loop while the charging station is not in accepted state`
      )
      return false
    }
    if (!this.chargingStation.isChargingStationAvailable()) {
      logger.info(
        `${this.logPrefix(
          connectorId
        )} entered in transaction loop while the charging station is unavailable`
      )
      return false
    }
    if (!this.chargingStation.isConnectorAvailable(connectorId)) {
      logger.info(
        `${this.logPrefix(
          connectorId
        )} entered in transaction loop while the connector ${connectorId} is unavailable`
      )
      return false
    }
    return true
  }

  private async waitChargingStationAvailable (connectorId: number): Promise<void> {
    let logged = false
    while (!this.chargingStation.isChargingStationAvailable()) {
      if (!logged) {
        logger.info(
          `${this.logPrefix(
            connectorId
          )} transaction loop waiting for charging station to be available`
        )
        logged = true
      }
      await sleep(Constants.CHARGING_STATION_ATG_AVAILABILITY_TIME)
    }
  }

  private async waitConnectorAvailable (connectorId: number): Promise<void> {
    let logged = false
    while (!this.chargingStation.isConnectorAvailable(connectorId)) {
      if (!logged) {
        logger.info(
          `${this.logPrefix(
            connectorId
          )} transaction loop waiting for connector ${connectorId} to be available`
        )
        logged = true
      }
      await sleep(Constants.CHARGING_STATION_ATG_AVAILABILITY_TIME)
    }
  }

  private initializeConnectorsStatus (): void {
    if (this.chargingStation.hasEvses) {
      for (const [evseId, evseStatus] of this.chargingStation.evses) {
        if (evseId > 0) {
          for (const connectorId of evseStatus.connectors.keys()) {
            this.connectorsStatus.set(connectorId, this.getConnectorStatus(connectorId))
          }
        }
      }
    } else {
      for (const connectorId of this.chargingStation.connectors.keys()) {
        if (connectorId > 0) {
          this.connectorsStatus.set(connectorId, this.getConnectorStatus(connectorId))
        }
      }
    }
  }

  private getConnectorStatus (connectorId: number): Status {
    const connectorStatus =
      this.chargingStation.getAutomaticTransactionGeneratorStatuses()?.[connectorId - 1] != null
        ? cloneObject<Status>(
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          this.chargingStation.getAutomaticTransactionGeneratorStatuses()![connectorId - 1]
        )
        : undefined
    if (connectorStatus != null) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      connectorStatus.startDate = convertToDate(connectorStatus.startDate)!
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      connectorStatus.lastRunDate = convertToDate(connectorStatus.lastRunDate)!
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      connectorStatus.stopDate = convertToDate(connectorStatus.stopDate)!
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      connectorStatus.stoppedDate = convertToDate(connectorStatus.stoppedDate)!
      if (
        !this.started &&
        (connectorStatus.start ||
          this.chargingStation.getAutomaticTransactionGeneratorConfiguration()?.enable !== true)
      ) {
        connectorStatus.start = false
      }
    }
    return (
      connectorStatus ?? {
        start: false,
        authorizeRequests: 0,
        acceptedAuthorizeRequests: 0,
        rejectedAuthorizeRequests: 0,
        startTransactionRequests: 0,
        acceptedStartTransactionRequests: 0,
        rejectedStartTransactionRequests: 0,
        stopTransactionRequests: 0,
        acceptedStopTransactionRequests: 0,
        rejectedStopTransactionRequests: 0,
        skippedConsecutiveTransactions: 0,
        skippedTransactions: 0
      }
    )
  }

  private async startTransaction (
    connectorId: number
  ): Promise<StartTransactionResponse | undefined> {
    const measureId = 'StartTransaction with ATG'
    const beginId = PerformanceStatistics.beginMeasure(measureId)
    let startResponse: StartTransactionResponse | undefined
    if (this.chargingStation.hasIdTags()) {
      const idTag = IdTagsCache.getInstance().getIdTag(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.chargingStation.getAutomaticTransactionGeneratorConfiguration()!.idTagDistribution!,
        this.chargingStation,
        connectorId
      )
      const startTransactionLogMsg = `${this.logPrefix(
        connectorId
      )} start transaction with an idTag '${idTag}'`
      if (this.getRequireAuthorize()) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ++this.connectorsStatus.get(connectorId)!.authorizeRequests
        if (await isIdTagAuthorized(this.chargingStation, connectorId, idTag)) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          ++this.connectorsStatus.get(connectorId)!.acceptedAuthorizeRequests
          logger.info(startTransactionLogMsg)
          // Start transaction
          startResponse = await this.chargingStation.ocppRequestService.requestHandler<
          StartTransactionRequest,
          StartTransactionResponse
          >(this.chargingStation, RequestCommand.START_TRANSACTION, {
            connectorId,
            idTag
          })
          this.handleStartTransactionResponse(connectorId, startResponse)
          PerformanceStatistics.endMeasure(measureId, beginId)
          return startResponse
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ++this.connectorsStatus.get(connectorId)!.rejectedAuthorizeRequests
        PerformanceStatistics.endMeasure(measureId, beginId)
        return startResponse
      }
      logger.info(startTransactionLogMsg)
      // Start transaction
      startResponse = await this.chargingStation.ocppRequestService.requestHandler<
      StartTransactionRequest,
      StartTransactionResponse
      >(this.chargingStation, RequestCommand.START_TRANSACTION, {
        connectorId,
        idTag
      })
      this.handleStartTransactionResponse(connectorId, startResponse)
      PerformanceStatistics.endMeasure(measureId, beginId)
      return startResponse
    }
    logger.info(`${this.logPrefix(connectorId)} start transaction without an idTag`)
    startResponse = await this.chargingStation.ocppRequestService.requestHandler<
    StartTransactionRequest,
    StartTransactionResponse
    >(this.chargingStation, RequestCommand.START_TRANSACTION, { connectorId })
    this.handleStartTransactionResponse(connectorId, startResponse)
    PerformanceStatistics.endMeasure(measureId, beginId)
    return startResponse
  }

  private async stopTransaction (
    connectorId: number,
    reason = StopTransactionReason.LOCAL
  ): Promise<StopTransactionResponse | undefined> {
    const measureId = 'StopTransaction with ATG'
    const beginId = PerformanceStatistics.beginMeasure(measureId)
    let stopResponse: StopTransactionResponse | undefined
    if (this.chargingStation.getConnectorStatus(connectorId)?.transactionStarted === true) {
      logger.info(
        `${this.logPrefix(
          connectorId
        )} stop transaction with id ${this.chargingStation.getConnectorStatus(connectorId)
          ?.transactionId}`
      )
      stopResponse = await this.chargingStation.stopTransactionOnConnector(connectorId, reason)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      ++this.connectorsStatus.get(connectorId)!.stopTransactionRequests
      if (stopResponse.idTagInfo?.status === AuthorizationStatus.ACCEPTED) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ++this.connectorsStatus.get(connectorId)!.acceptedStopTransactionRequests
      } else {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ++this.connectorsStatus.get(connectorId)!.rejectedStopTransactionRequests
      }
    } else {
      const transactionId = this.chargingStation.getConnectorStatus(connectorId)?.transactionId
      logger.debug(
        `${this.logPrefix(connectorId)} stopping a not started transaction${
          transactionId != null ? ` with id ${transactionId}` : ''
        }`
      )
    }
    PerformanceStatistics.endMeasure(measureId, beginId)
    return stopResponse
  }

  private getRequireAuthorize (): boolean {
    return (
      this.chargingStation.getAutomaticTransactionGeneratorConfiguration()?.requireAuthorize ?? true
    )
  }

  private readonly logPrefix = (connectorId?: number): string => {
    return logPrefix(
      ` ${this.chargingStation.stationInfo?.chargingStationId} | ATG${
        connectorId != null ? ` on connector #${connectorId}` : ''
      }:`
    )
  }

  private handleStartTransactionResponse (
    connectorId: number,
    startResponse: StartTransactionResponse
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    ++this.connectorsStatus.get(connectorId)!.startTransactionRequests
    if (startResponse.idTagInfo.status === AuthorizationStatus.ACCEPTED) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      ++this.connectorsStatus.get(connectorId)!.acceptedStartTransactionRequests
    } else {
      logger.warn(`${this.logPrefix(connectorId)} start transaction rejected`)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      ++this.connectorsStatus.get(connectorId)!.rejectedStartTransactionRequests
    }
  }
}

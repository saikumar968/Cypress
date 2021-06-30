import { EventEmitter } from 'events'
import { action } from 'mobx'
import appState, { AppState } from './app-state'
import runnablesStore, { RunnablesStore, RootRunnable, LogProps } from '../runnables/runnables-store'
import statsStore, { StatsStore, StatsStoreStartInfo } from '../header/stats-store'
import scroller, { Scroller } from './scroller'
import TestModel, { UpdatableTestProps, UpdateTestCallback, TestProps } from '../test/test-model'
import { SessionProps } from '../sessions/sessions-model'

const localBus = new EventEmitter()

interface InitEvent {
  appState: AppState
  runnablesStore: RunnablesStore
  statsStore: StatsStore
  scroller: Scroller
}

export interface Runner {
  emit: ((event: string, payload?: any) => void)
  on: ((event: string, action: ((...args: any) => void)) => void)
}

export interface Events {
  appState: AppState
  runnablesStore: RunnablesStore
  statsStore: StatsStore
  scroller: Scroller

  init: ((args: InitEvent) => void)
  listen: ((runner: Runner) => void)
  emit: ((event: string | symbol, ...args: any) => void)
  __off: (() => void)
}

interface StartInfo extends StatsStoreStartInfo {
  autoScrollingEnabled: boolean
  firefoxGcInterval: number
  scrollTop: number
  studioActive: boolean
}

type CollectRunStateCallback = (arg: {
  autoScrollingEnabled: boolean
  scrollTop: number
}) => void

const events: Events = {
  appState,
  runnablesStore,
  statsStore,
  scroller,

  init ({ appState, runnablesStore, statsStore, scroller }: InitEvent) {
    this.appState = appState
    this.runnablesStore = runnablesStore
    this.statsStore = statsStore
    this.scroller = scroller
  },

  listen (runner: Runner) {
    const { appState, runnablesStore, scroller, statsStore } = this

    runner.on('runnables:ready', action('runnables:ready', (rootRunnable: RootRunnable = {}) => {
      runnablesStore.setRunnables(rootRunnable)
    }))

    runner.on('reporter:log:add', action('log:add', (log: LogProps) => {
      runnablesStore.addLog(log)
    }))

    runner.on('reporter:log:state:changed', action('log:update', (log: LogProps) => {
      runnablesStore.updateLog(log)
    }))

    runner.on('session:add', action('session:add', (props: SessionProps) => {
      runnablesStore._withTest(props.testId, (test) => test.addSession(props))
    }))

    runner.on('reporter:log:remove', action('log:remove', (log: LogProps) => {
      runnablesStore.removeLog(log)
    }))

    runner.on('reporter:restart:test:run', action('restart:test:run', () => {
      appState.reset()
      runnablesStore.reset()
      statsStore.reset()
      runner.emit('reporter:restarted')
    }))

    runner.on('run:start', action('run:start', () => {
      if (runnablesStore.hasTests) {
        appState.startRunning()
      }
    }))

    runner.on('reporter:start', action('start', (startInfo: StartInfo) => {
      appState.temporarilySetAutoScrolling(startInfo.autoScrollingEnabled)
      appState.setFirefoxGcInterval(startInfo.firefoxGcInterval)
      runnablesStore.setInitialScrollTop(startInfo.scrollTop)
      appState.setStudioActive(startInfo.studioActive)
      if (runnablesStore.hasTests) {
        statsStore.start(startInfo)
      }
    }))

    runner.on('test:before:run:async', action('test:before:run:async', (runnable: TestProps) => {
      runnablesStore.runnableStarted(runnable)
    }))

    runner.on('test:after:run', action('test:after:run', (runnable: TestProps) => {
      runnablesStore.runnableFinished(runnable)
      if (runnable.final && !appState.studioActive) {
        statsStore.incrementCount(runnable.state!)
      }
    }))

    runner.on('test:set:state', action('test:set:state', (props: UpdatableTestProps, cb: UpdateTestCallback) => {
      runnablesStore.updateTest(props, cb)
    }))

    runner.on('paused', action('paused', (nextCommandName: string) => {
      appState.pause(nextCommandName)
      statsStore.pause()
    }))

    runner.on('run:end', action('run:end', () => {
      appState.end()
      statsStore.end()
    }))

    runner.on('reporter:collect:run:state', (cb: CollectRunStateCallback) => {
      cb({
        autoScrollingEnabled: appState.autoScrollingEnabled,
        scrollTop: scroller.getScrollTop(),
      })
    })

    runner.on('reporter:snapshot:unpinned', action('snapshot:unpinned', () => {
      appState.pinnedSnapshotId = null
    }))

    runner.on('before:firefox:force:gc', action('before:firefox:force:gc', ({ gcInterval }) => {
      appState.setForcingGc(true)
      appState.setFirefoxGcInterval(gcInterval)
    }))

    runner.on('after:firefox:force:gc', action('after:firefox:force:gc', ({ gcInterval }) => {
      appState.setForcingGc(false)
      appState.setFirefoxGcInterval(gcInterval)
    }))

    localBus.on('resume', action('resume', () => {
      appState.resume()
      statsStore.resume()
      runner.emit('runner:resume')
    }))

    localBus.on('next', action('next', () => {
      appState.resume()
      statsStore.resume()
      runner.emit('runner:next')
    }))

    localBus.on('stop', action('stop', () => {
      appState.stop()
      runner.emit('runner:stop')
    }))

    localBus.on('restart', action('restart', () => {
      runner.emit('runner:restart')
    }))

    localBus.on('show:command', (commandId) => {
      runner.emit('runner:console:log', commandId)
    })

    localBus.on('show:error', (test: TestModel) => {
      const command = test.err.isCommandErr ? test.commandMatchingErr() : null

      runner.emit('runner:console:error', {
        err: test.err,
        commandId: command?.id,
      })
    })

    localBus.on('show:snapshot', (commandId) => {
      runner.emit('runner:show:snapshot', commandId)
    })

    localBus.on('hide:snapshot', (commandId) => {
      runner.emit('runner:hide:snapshot', commandId)
    })

    localBus.on('pin:snapshot', (commandId) => {
      runner.emit('runner:pin:snapshot', commandId)
    })

    localBus.on('unpin:snapshot', (commandId) => {
      runner.emit('runner:unpin:snapshot', commandId)
    })

    localBus.on('focus:tests', () => {
      runner.emit('focus:tests')
    })

    localBus.on('get:user:editor', (cb) => {
      runner.emit('get:user:editor', cb)
    })

    localBus.on('clear:session', (cb) => {
      runner.emit('clear:session', cb)
    })

    localBus.on('set:user:editor', (editor) => {
      runner.emit('set:user:editor', editor)
    })

    localBus.on('save:state', () => {
      runner.emit('save:state', {
        autoScrollingEnabled: appState.autoScrollingEnabled,
      })
    })

    localBus.on('external:open', (url) => {
      runner.emit('external:open', url)
    })

    localBus.on('open:file', (fileDetails) => {
      runner.emit('open:file', fileDetails)
    })

    localBus.on('studio:init:test', (testId) => {
      runner.emit('studio:init:test', testId)
    })

    localBus.on('studio:init:suite', (suiteId) => {
      runner.emit('studio:init:suite', suiteId)
    })

    localBus.on('studio:remove:command', (commandId) => {
      runner.emit('studio:remove:command', commandId)
    })

    localBus.on('studio:cancel', () => {
      runner.emit('studio:cancel')
    })

    localBus.on('studio:save', () => {
      runner.emit('studio:save')
    })

    localBus.on('studio:copy:to:clipboard', (cb) => {
      runner.emit('studio:copy:to:clipboard', cb)
    })
  },

  emit (event, ...args) {
    localBus.emit(event, ...args)
  },

  // for testing purposes
  __off () {
    localBus.removeAllListeners()
  },
}

export default events

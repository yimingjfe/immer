import {
    is,
    has,
    isProxyable,
    isProxy,
    PROXY_STATE,
    shallowCopy,
    RETURNED_AND_MODIFIED_ERROR,
    each,
    useProxies,
    // finalize,
    freeze
} from "./common"

// state.proxies有什么用，为什么不直接用state.copy？

// parent都有什么用？  改变子属性，意味着父属性也要markChanged

// 为什么新的对象get的时候，不需要创建代理？ 新对象的值不需要做代理，修改的时候直接覆盖即可

// PROXY_STATE有两个作用，一是便于取state上的值，如Modified，另一个是帮助验证是不是设置过代理了

// 可以提两个pr，第一个是shallowCopy丢掉了原型链，一个是isPlainObject的判断太复杂了

function finalize(base) {
    if (isProxy(base)) {
        const state = base[PROXY_STATE]
        if (state.modified === true) {
            if (state.finalized === true) return state.copy
            state.finalized = true
            return finalizeObject(
                useProxies ? state.copy : (state.copy = shallowCopy(base)),
                state
            )
        } else {
            return state.base
        }
    }
    finalizeNonProxiedObject(base)
    return base
}

// function finalize(base) {
//     if (isProxy(base)) {
//         const state = base[PROXY_STATE]
//         if (state.modified === true) {
//             if (state.finalized === true) return state.copy
//             state.finalized = true
//             return finalizeObject(
//                 useProxies ? state.copy : (state.copy = shallowCopy(base)),
//                 state
//             )
//         } else {
//             return state.base
//         }
//     }
//     finalizeNonProxiedObject(base)
//     return base
// }

function finalizeNonProxiedObject(parent) {
    if (!isProxyable(parent)) return
    if (Object.isFrozen(parent)) return
    // each(parent, (i, child) => {
    //     parent[i] = finalize(child)
    // })
    each(parent, (i, child) => {
        if (isProxy(child)) {
            parent[i] = finalize(child)
        } else finalizeNonProxiedObject(child)
    })
    freeze(parent)
}

function finalizeObject(copy, state) {
    const base = state.base
    each(copy, (prop, value) => {
        if (value !== base[prop]) copy[prop] = finalize(value)
    })
    return freeze(copy)
}

let proxies = null
const objectTraps = {
    get,
    has(target, prop) {
        return prop in source(target)
    },
    ownKeys(target) {
        return Reflect.ownKeys(source(target))
    },
    set,
    deleteProperty,
    getOwnPropertyDescriptor,
    defineProperty,
    setPrototypeOf() {
        throw new Error("Immer does not support `setPrototypeOf()`.")
    }
}

const arrayTraps = {}
each(objectTraps, (key, fn) => {
    arrayTraps[key] = function() {
        arguments[0] = arguments[0][0]
        return fn.apply(this, arguments)
    }
})

function getOwnPropertyDescriptor(state, prop) {
    const owner = state.modified
        ? state.copy
        : has(state.proxies, prop) ? state.proxies : state.base
    const descriptor = Reflect.getOwnPropertyDescriptor(owner, prop)
    if (descriptor && !(Array.isArray(owner) && prop === "length"))
        descriptor.configurable = true
    return descriptor
}

function defineProperty() {
    throw new Error(
        "Immer does not support defining properties on draft objects."
    )
}

function deleteProperty(target, prop) {
    markChanged(target)
    Reflect.deleteProperty(source(target), prop)
    return true
}

function source(state) {
    return state.modified === true ? state.copy : state.base
}

function markChanged(state) {
    if (!state.modified) {
        state.modified = true
        state.copy = shallowCopy(state.base)
        Object.assign(state.copy, state.proxies)
        if (state.parent) markChanged(state.parent)
    }
}

function set(state, prop, value) {
    if (!state.modified) {
        if (
            (prop in state.base && is(state.base[prop], value)) ||
            (has(state.proxies, prop) && state.proxies[prop] === value)
        ) {
            return true
        }
        markChanged(state)
    }
    state.copy[prop] = value
    return true
}

function get(state, prop) {
    if (prop === PROXY_STATE) return state
    if (state.modified) {
        const value = state.copy[prop]
        if (value === state.base[prop] && isProxyable(value))
            return (state.copy[prop] = createProxy(state, value))
        return value
    } else {
        if (has(state.proxies, prop)) return state.proxies[prop]
        if (!isProxy(state.base[prop]) && isProxyable(state.base[prop])) {
            return (state.proxies[prop] = createProxy(state, state.base[prop]))
        }
        return state.base[prop]
    }
}

function createState(parent, base) {
    return {
        base,
        parent,
        copy: undefined,
        proxies: {},
        modified: false,
        finalized: false
    }
}

function createProxy(parent, base) {
    if (isProxy(base)) throw new Error("Immer bug. Plz report.")
    const state = createState(parent, base)
    const proxy = Array.isArray(base)
        ? Proxy.revocable([state], arrayTraps)
        : Proxy.revocable(state, objectTraps)
    proxies.push(proxy)
    return proxy.proxy
}

export function produceProxy(baseState, producer) {
    proxies = []
    const rootProxy = createProxy(undefined, baseState)
    const returnValue = producer.call(rootProxy, rootProxy)
    let result
    if (returnValue !== undefined && returnValue !== rootProxy) {
        if (rootProxy[PROXY_STATE].modified)
            throw new Error(RETURNED_AND_MODIFIED_ERROR)

        result = finalize(returnValue)
    } else {
        result = finalize(rootProxy)
    }
    each(proxies, (_, p) => p.revoke())
    return result
}

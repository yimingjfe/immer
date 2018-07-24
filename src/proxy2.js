import {
    finalize,
    isProxy,
    PROXY_STATE,
    isProxyable,
    shallowCopy
} from "./common"

// state.proxies有什么用，为什么不直接用state.copy？

// parent都有什么用？  改变子属性，意味着父属性也要markChanged

// 为什么新的对象get的时候，不需要创建代理？ 新对象的值不需要做代理，修改的时候直接覆盖即可

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

function get(target, prop) {
    if (prop === PROXY_STATE) return target
    if (target.modified) {
        if (!isProxy(target.copy[prop] && isProxyable(target.copy[prop]))) {
            return (target.copy[prop] = createProxy(
                target.copy,
                target.copy[prop]
            ))
        }
        return target.copy[prop]
    } else {
        if (has(target.proxies, prop)) return target.proxies[prop]
        if (!isProxy(target.base[prop] && isProxyable(target.base[prop]))) {
            return (target.proxies[prop] = createProxy(
                target,
                target.base[prop]
            ))
        }
        return target.base[prop]
    }
}

function createState(parent, base) {
    return {
        base,
        parent,
        copy: undefined,
        proxies: {},
        modified: false
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
    const rootProxy = createProxy(undefined, baseState)
    const returnValue = producer.call(rootProxy, rootProxy)
    proxies = []
    let result
    if (returnValue !== undefined && returnValue !== rootProxy) {
        if (rootProxy[PROXY_STATE].modified)
            throw new Error(RETURNED_AND_MODIFIED_ERROR)

        // See #117
        // Should we just throw when returning a proxy which is not the root, but a subset of the original state?
        // Looks like a wrongly modeled reducer
        result = finalize(returnValue)
    } else {
        result = finalize(rootProxy)
    }
    each(proxies, (_, p) => p.revoke())
    return result
}

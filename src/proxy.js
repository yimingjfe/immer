"use strict"
// @ts-check

import {
    is,
    has,
    isProxyable,
    isProxy,
    PROXY_STATE,
    finalize,
    shallowCopy,
    RETURNED_AND_MODIFIED_ERROR,
    each
} from "./common"

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
        // console.log('key', key, arguments)
        arguments[0] = arguments[0][0]
        return fn.apply(this, arguments) // state push proxy
    }
})

function createState(parent, base) {
    return {
        modified: false,
        finalized: false,
        parent,
        base,
        copy: undefined,
        proxies: {}
    }
}

function source(state) {
    return state.modified === true ? state.copy : state.base
}

function get(state, prop) {
    // get的时候都会创建代理，返回的是copy的值或base的值
    if (prop === PROXY_STATE) return state
    if (state.modified) {
        // 如果修改过，就拿copy[prop]的值创建代理，然后返回这个代理
        const value = state.copy[prop] // set之后copy上有最全的值
        if (value === state.base[prop] && isProxyable(value))
            // 修改了其他属性，但是当前值没有变化  如果这个值发生了变化，证明copy上有副本了
            // only create proxy if it is not yet a proxy, and not a new object
            // (new objects don't need proxying, they will be processed in finalize anyway)
            return (state.copy[prop] = createProxy(state, value))
        return value
    } else {
        // 为什么不仅仅维护一个copy，还要多维护一个proxies?如果只有一个copy，可以set的时候有的值不覆盖不就行了
        if (has(state.proxies, prop)) return state.proxies[prop] // 如果没被修改代理上有对应值的话，就返回代理上的值
        const value = state.base[prop] // 没有变化就直接取base上的数据
        if (!isProxy(value) && isProxyable(value))
            // 获取的值如果是一个PlainObject或数组，就创建代理
            return (state.proxies[prop] = createProxy(state, value))
        return value
    }
}

function set(state, prop, value) {
    // set的关键是不改老的值，所以改的copy上的值
    if (!state.modified) {
        if (
            (prop in state.base && is(state.base[prop], value)) ||
            (has(state.proxies, prop) && state.proxies[prop] === value) //值不变的情况下return true
        )
            return true
        markChanged(state) // 标记state.modified变化，标记parent.modified变化
    }
    state.copy[prop] = value
    return true
}

function deleteProperty(state, prop) {
    markChanged(state)
    delete state.copy[prop]
    return true
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

function markChanged(state) {
    if (!state.modified) {
        state.modified = true
        state.copy = shallowCopy(state.base) // 这是否意味着对象的属性是对象的情况下，该对象的__proto__的值都丢失？
        // copy the proxies over the base-copy
        Object.assign(state.copy, state.proxies) // yup that works for arrays as well
        if (state.parent) markChanged(state.parent)
    }
}

// creates a proxy for plain objects / arrays
function createProxy(parentState, base) {
    if (isProxy(base)) throw new Error("Immer bug. Plz report.")
    const state = createState(parentState, base)
    const proxy = Array.isArray(base)
        ? Proxy.revocable([state], arrayTraps)
        : Proxy.revocable(state, objectTraps)
    proxies.push(proxy)
    return proxy.proxy
}

export function produceProxy(baseState, producer) {
    if (isProxy(baseState)) {
        // See #100, don't nest producers
        const returnValue = producer.call(baseState, baseState)
        return returnValue === undefined ? baseState : returnValue
    }
    const previousProxies = proxies
    proxies = [] // 通过createProxy创建的proxy都会在这里面
    try {
        // create proxy for root
        const rootProxy = createProxy(undefined, baseState) // 创建根代理
        // execute the thunk
        const returnValue = producer.call(rootProxy, rootProxy) // 执行函数，拿到返回值
        // and finalize the modified proxy
        let result
        // check whether the draft was modified and/or a value was returned
        if (returnValue !== undefined && returnValue !== rootProxy) {
            // something was returned, and it wasn't the proxy itself
            if (rootProxy[PROXY_STATE].modified)
                throw new Error(RETURNED_AND_MODIFIED_ERROR)

            // See #117
            // Should we just throw when returning a proxy which is not the root, but a subset of the original state?
            // Looks like a wrongly modeled reducer
            result = finalize(returnValue)
        } else {
            result = finalize(rootProxy)
        }
        // revoke all proxies
        each(proxies, (_, p) => p.revoke())
        return result
    } finally {
        proxies = previousProxies
    }
}

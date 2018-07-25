export const PROXY_STATE =
    typeof Symbol !== "undefined"
        ? Symbol("immer-proxy-state")
        : "__$immer_state"

export const RETURNED_AND_MODIFIED_ERROR =
    "An immer producer returned a new value *and* modified its draft. Either return a new value *or* modify the draft."

function verifyMinified() {}

const inProduction =
    (typeof process !== "undefined" && process.env.NODE_ENV === "production") ||
    verifyMinified.name !== "verifyMinified"

let autoFreeze = !inProduction
let useProxies = typeof Proxy !== "undefined"

/**
 * Automatically freezes any state trees generated by immer.
 * This protects against accidental modifications of the state tree outside of an immer function.
 * This comes with a performance impact, so it is recommended to disable this option in production.
 * It is by default enabled.
 *
 * @returns {void}
 */
export function setAutoFreeze(enableAutoFreeze) {
    autoFreeze = enableAutoFreeze
}

export function setUseProxies(value) {
    useProxies = value
}

export function getUseProxies() {
    return useProxies
}

export function isProxy(value) {
    return !!value && !!value[PROXY_STATE]
}

// typeof value != null && typeof value === 'object' && (proto === null || proto ==== Object.proptotype)
export function isProxyable(value) {
    if (!value) return false // null 不行
    if (typeof value !== "object") return false // 必须是对象
    if (Array.isArray(value)) return true
    const proto = Object.getPrototypeOf(value)
    return proto === null || proto === Object.prototype
}

export function freeze(value) {
    if (autoFreeze) {
        Object.freeze(value)
    }
    return value
}

const assign =
    Object.assign ||
    function assign(target, value) {
        for (let key in value) {
            if (has(value, key)) {
                target[key] = value[key]
            }
        }
        return target
    }

export function shallowCopy(value) {
    if (Array.isArray(value)) return value.slice()
    const target = value.__proto__ === undefined ? Object.create(null) : {}
    return assign(target, value)
}

export function each(value, cb) {
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) cb(i, value[i])
    } else {
        for (let key in value) cb(key, value[key])
    }
}

export function has(thing, prop) {
    return Object.prototype.hasOwnProperty.call(thing, prop)
}

// given a base object, returns it if unmodified, or return the changed cloned if modified
export function finalize(base) {
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
            return state.base // 没做任何变化，会返回原属性状态
        }
    }
    finalizeNonProxiedObject(base)
    return base
}

function finalizeObject(copy, state) {
    // 说明state上的某个属性已经变化了
    // copy 与 base比较，不一样要finalize
    // copy上的值不变为什么不管？copy上的值没变化，它可能是个代理
    // 没变化说明没有set，没set说明该对象base上的值是可靠的
    // 一样的说明不是一个代理值，说明连get都没调用过，所以不需要处理
    const base = state.base
    each(copy, (prop, value) => {
        if (value !== base[prop]) copy[prop] = finalize(value)
    })
    return freeze(copy)
}

function finalizeNonProxiedObject(parent) {
    // If finalize is called on an object that was not a proxy, it means that it is an object that was not there in the original
    // tree and it could contain proxies at arbitrarily places. Let's find and finalize them as well
    if (!isProxyable(parent)) return
    if (Object.isFrozen(parent)) return
    each(parent, (i, child) => {
        if (isProxy(child)) {
            parent[i] = finalize(child)
        } else finalizeNonProxiedObject(child)
    })
    // always freeze completely new data
    freeze(parent)
}

export function verifyReturnValue(returnedValue, proxy, isProxyModified) {
    if (returnedValue !== undefined && returnedValue !== proxy) {
        // something was returned, and it wasn't the proxy itself
        if (isProxyModified)
            throw new Error(
                "An immer producer returned a new value *and* modified its draft. Either return a new value *or* modify the draft."
            )
    }
}

export function is(x, y) {
    // From: https://github.com/facebook/fbjs/blob/c69904a511b900266935168223063dd8772dfc40/packages/fbjs/src/core/shallowEqual.js
    if (x === y) {
        return x !== 0 || 1 / x === 1 / y
    } else {
        return x !== x && y !== y
    }
}

'use strict'

const updateUtil = require('./update-util')
const debug = require('debug') ('vapor-master:topic-util')

// build regex to match given root subpath
exports.subpathRegEx = (db, subpath) => {

  if (subpath[0] !== '/') {
    throw new Error(`subpath must be root ('/..'): '${subpath}'`)
  }

  // $& means the whole matched string
  let clean = subpath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // make sure there is trailing slash so regex doesnt match partial dir name
  // * subpath '/animal/cat' should match '/animal/cat/calico'
  // * but not '/animal/cattle/holstein' or '/android/animal/cat/siamese'
  // * so regex should be /^/animal/cat\//
  if (clean[clean.length - 1] !== '/') { clean += '/' }

  return new RegExp('^' + clean)
}

// remove all topic & topic xub docs & resolve to # removed
exports.clean = async (db ) => {
  const found = await Promise.all([
    db.Vapor.topic.find().exec(), // get all topics
    db.Vapor.topicXub.find().exec(), // get all topic pubs/subs
  ])

  const removed = []
  for (const docs of found) {
    for (const doc of docs) {
      removed.push(doc.remove()) // init remove & collect promise
    }
  }

  await Promise.all(removed) // wait for remove operations to resolve
  return removed.length // return # removed
}

// log method call to vapor master touching a topic
// if there is no record of topic with given path create it
exports.logTouch = async (db, topicPath, topicType, ipv4) => {
  debug(`topic at path '${topicPath}' touched from ip '${ipv4}'`)

  let topic = await exports.getByPath(db, topicPath) // try backend for doc

  if (!topic) { // if doc for topic path isnt in collection create it
    topic = new db.Vapor.topic({ topicPath, })
  }
  if (topicType && !topic.msgType) { // if msg type isnt set, set it now
    topic.msgType = topicType
  } else if (topicType && topic.msgType){
    if (topic.msgType == "*" && topicType != "*"){
      debug("replacing topic " + topicPath + " type " + topic.msgType + " with type " + topicType)
      topic.msgType = topicType
    }
  }
  topic.touched = { ipv4, } // push touch, date.now set by model
  topic.failed = undefined
  await topic.save() // wait for backend write to resolve
}

exports.getByPath = async (db, path) => {

  // reverse sort by creation date to keep behavior deterministic
  // there *should* only be one but that isnt enforced
  const topics = await db.Vapor.topic.find()
    .sort('-created').where('topicPath').equals(path).exec()

  if (topics.length < 1) {
    return undefined
  }
  if (topics.length > 1) {
    console.log(`WARNING: multiple topics with path '${path}'`)
  }
  return topics[0] // return first topic (newest)
}

exports.getPubsBySubpath = (db, subpath) => {

  // if subpath given build regex to match subpath at beginning of path
  if (subpath) {
    const re = exports.subpathRegEx(db, subpath)

    return db.Vapor.topicXub.find()
      .where('role').equals('pub').where('topicPath').regex(re).exec()

  // otherwise return all topics
  } else {
    return db.Vapor.topicXub.find()
      .where('role').equals('pub').exec()
  }
}

exports.getTopicXubsFromNodePath = async (db, nodePath) =>{
  const topicsXubs = await db.Vapor.topicXub.find().where('xubPath').equals(nodePath);
  return topicsXubs
}

// get list of [topicPath, msgType] pairs for topics with at least 1 pub
exports.getPubPairs = (db, subpath) => {
  return exports.getPubsBySubpath(db, subpath)
    .then((xubs)=>{
      return exports.getTopicsFromXubs(db, xubs)
    })
    .then((topics)=>{
      return exports.getPairsFromTopics(db, topics)
    })
}

// resolve from a list of xubs to a list of (unique) topics
exports.getTopicsFromXubs = (db, xubs = []) => {

  // build a list of unique topic paths from passed xubs list
  const paths = {}
  for (const xub of xubs) {
    paths[xub.topicPath] = true
  }

  // build a list of promises that will resolve to a topic for each path
  const topics = []
  for (const path of Object.keys(paths)) {
    topics.push(exports.getByPath(db, path))
  }

  return Promise.all(topics)
}

// resolves to a list with a [topicPath, msgType] pair for each given topic
exports.getPairsFromTopics = (db, topics = []) => {
  const pairs = []
  for (const topic of topics) {
    pairs.push([ topic.topicPath, topic.msgType, ])
  }
  return Promise.resolve(pairs)
}

// resolves to a list of [topicPath, msgType] pairs for all topics
exports.getAllPairs = (db) => {
  return db.Vapor.topic.find().exec()
    .then((topics)=>{
      return exports.getPairsFromTopics(db, topics)
    })
}

// (optionally) takes a list and appends publisher & subscriber lists
// returns promise that resolves to [(..listcontents,) pubs, subs]
// where pubs -> [ [topicPath1, [topic1PubPath1...topic1PubPathN]] ... ]
// and subs -> [ [topicPath1, [topic1SubPath1...topic1SubPathN]] ... ]
exports.listXubs = async (db, list = []) => {

  // get all topic pubs & subs from backend
  const topicXubs = await db.Vapor.topicXub.find().exec()

  // loop thru xubs and add to pub or sub map by topic
  const pubmap = {}
  const submap = {}
  for (const xub of topicXubs) {
    const map = (xub.role === 'pub') ? pubmap : submap
    if (!(xub.topicPath in map)) { map[xub.topicPath] = [] }
    map[xub.topicPath].push(xub.xubPath)
  }
  
  // convert maps to lists, push into passed list & return
  list.push(Object.entries(pubmap))
  list.push(Object.entries(submap))
  return list
}

// get list of pub/sub uris at given topic path
exports.getXubUris = async (db, role, topicPath) => {
  const xubs = await db.Vapor.topicXub.find()
    .where('role').equals(role)
    .where('topicPath').equals(topicPath).exec()

  const uris = []
  for (const xub of xubs) {
    uris.push(xub.xubUri)
  }
  return uris
}

// resolves to list of deleted xubs
exports.removeXub = async (db, role, xubUri, topicPath) => {
  const xubs = await db.Vapor.topicXub.find()
    .where('role').equals(role)
    .where('topicPath').equals(topicPath)
    .where('xubUri').equals(xubUri).exec()

  const removed = []
  for (const xub of xubs) {
    removed.push(xub.remove())
  }
  if (removed.length > 1) {
    console.log(
      `WARNING: removed ${removed.length} ${role}s at ${xubUri} for`
      + ` topic ${topicPath}`)
  }
  return removed
}

// create new topic sub & write to backend
exports.createXub = async (db, role, topicPath, msgType, xubPath, xubUri, xubIpv4) => {
  const xubs = await db.Vapor.topicXub.find().exec()
  let matches = xubs.filter((xub,i,arr)=>{
    if (xub.role == role &&
        xub.msgType == msgType &&
        xub.topicPath == topicPath &&
        xub.xubPath == xubPath &&
        xub.xubUri == xubUri &&
        xubIpv4 == xubIpv4){
      return true
    }
    return false;
  })

  if (matches.length > 0){
    return matches[0];
  }
  return db.Vapor.topicXub.create({
    role: role,
    topicPath: topicPath,
    msgType: msgType,
    xubPath: xubPath,
    xubUri: xubUri,
    xubIpv4: xubIpv4,
  })
}

// update is asynchronous dont need to wait for promises to resolve
exports.updateSubs = async (db, topicPath, subUris) => {
  const pubUris = await exports.getXubUris(db, 'pub', topicPath)

  for (const subUri of subUris) {
    updateUtil.updateTopicSub(db, subUri, topicPath, pubUris)
  }
}

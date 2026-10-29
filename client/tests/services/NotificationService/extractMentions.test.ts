// NotificationService.extractMentions decides whom a new caw notifies as
// "mentioned". It has to read a post the way the composer and the feed do: the
// `@handle` inside a link (https://www.youtube.com/@name, https://medium.com/@name)
// is part of the URL, not a mention of the CAW user with that name. Pure
// function; no database.

import { expect } from 'chai'
import { NotificationService } from '../../../src/services/NotificationService'

const extract = (s: string) => NotificationService.extractMentions(s)

describe('NotificationService.extractMentions', () => {
  it('finds @mentions in order, deduped', () => {
    expect(extract('hi @maria and @bob, again @maria')).to.deep.equal(['maria', 'bob'])
  })

  it('still finds a mention written right before Japanese text (an honorific, no space)', () => {
    expect(extract('@zinsanjpさん、こんにちは')).to.deep.equal(['zinsanjp'])
  })

  it('caps the list', () => {
    const many = Array.from({ length: 15 }, (_, i) => `@u${i}`).join(' ')
    expect(extract(many)).to.have.lengthOf(NotificationService.MAX_MENTIONS_PER_CAW)
  })

  it('does not take the @handle in a link for a mention', () => {
    expect(extract('https://www.youtube.com/@gilgamesh')).to.deep.equal([])
    expect(extract('read https://medium.com/@maria/some-post today')).to.deep.equal([])
    expect(extract('https://mastodon.social/@alice/1234')).to.deep.equal([])
    expect(extract('http://example.com/a?next=@bob#frag')).to.deep.equal([])
  })

  it('still finds a real mention next to a link', () => {
    expect(extract('@maria look at https://www.youtube.com/@gilgamesh')).to.deep.equal(['maria'])
    expect(extract('https://medium.com/@maria/x thanks @bob')).to.deep.equal(['bob'])
    expect(extract('see (https://medium.com/@maria/x), @bob.')).to.deep.equal(['bob'])
  })
})

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Simple error boundary to show runtime errors on the page if anything breaks later
class ErrorBoundary extends React.Component {
  constructor(p){ super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error){ return { error }; }
  componentDidCatch(error, info){ console.error('Runtime error:', error, info); }
  render(){
    if (this.state.error) {
      return (
        <div style={{padding:16, background:'#fee2e2', color:'#991b1b', fontFamily:'system-ui'}}>
          <h2 style={{marginTop:0}}>Something went wrong</h2>
          <div style={{whiteSpace:'pre-wrap'}}>{String(this.state.error?.message || this.state.error)}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
